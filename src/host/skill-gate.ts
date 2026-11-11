import type { ToolExecution } from './dsh.ts'

/**
 * The writing tools whose first call in a turn must be preceded by reading the
 * curator skill.
 *
 * Named one by one rather than matched by prefix: `mnemon_recall` reads the
 * library and must never be gated, and a prefix rule on `mnemon_` would catch it.
 */
const GATED_TOOLS: ReadonlySet<string> = new Set([
  'mnemon_runtime_memory',
  'mnemon_remember',
  'mnemon_forget',
  'mnemon_document_create',
  'mnemon_document_manage',
])

/**
 * Files a write to which counts as writing memory, a rule, or the index.
 *
 * Suffixes rather than absolute paths: the same profile runs on machines with
 * different home directories, and the gate does not need to know where they are.
 * Matched only for `write` and `edit`, which are general purpose — gating every
 * write would stop scratch files.
 */
const GATED_PATHS: readonly string[] = [
  '/.mnemon/runtime/MEMORY.md',
  '/.mnemon/runtime/USER.md',
  '/.agents/AGENTS.md',
  '/.dsh/AGENTS.md',
]

/**
 * A shell command that writes one of the gated files.
 *
 * One regex covering both platforms' idioms, because the same profile runs on
 * Linux and on Windows and the gate cannot ask which: POSIX redirection and
 * `tee`; PowerShell's `Set-Content`, `Add-Content`, `Out-File` and `>` redirection
 * (which differs only in that the target may precede nothing at all); and the
 * editing commands that rewrite a file in place — `sed -i`, `perl -pi`, `cp`,
 * `mv`, `dd of=`, `install`, `truncate`.
 *
 * Deliberately not exhaustive: `python -c "open(...).write(...)"` and a helper
 * script both slip through, and always will. The gate exists to make the skill be
 * read, not to stop a determined writer, and every widening costs a false refusal
 * on a read.
 */
const GATED_FILE = /(?:MEMORY|USER|AGENTS)\.md/u

/**
 * Where a command sends its output, or `undefined` when nothing can be found.
 *
 * The distinction the gate needs is not "does this command mention a gated file"
 * but "is a gated file the thing being written". `cp AGENTS.md /tmp/backup` and
 * `cat AGENTS.md > /tmp/copy` both name the file and neither touches it — and
 * backing up the index before editing it is the routine this gate must not block.
 *
 * Extraction, not verification: this returns a best-effort list of destinations
 * and the caller asks whether any of them is gated. An unparseable command yields
 * `undefined` and the caller treats that as "could be anything" only when the
 * command also carries a write verb — see `shellWritesGatedFile`.
 */
function writeTargets(command: string): string[] {
  const targets: string[] = []

  // POSIX redirection, per segment: `> f`, `>> f`, `>f`, with an optional `&1`
  // style descriptor that is not a path.
  for (const match of command.matchAll(/(?:^|[^<>&\d])>>?\s*([^\s|;&<>()]+)/gu)) {
    const target = match[1]
    if (target !== undefined && !/^&\d$/u.test(target)) targets.push(target)
  }

  // `tee [-a] f...` — every operand after the flags is a destination.
  for (const match of command.matchAll(/(?:^|[|;&]\s*|\s)tee\s+((?:-{1,2}[\w-]+\s+)*)([^|;&<>]+)/gu)) {
    for (const word of (match[2] ?? '').trim().split(/\s+/u)) {
      if (word !== '' && !word.startsWith('-')) targets.push(word)
    }
  }

  // `dd ... of=f`.
  for (const match of command.matchAll(/\bof=([^\s|;&<>]+)/gu)) {
    if (match[1] !== undefined) targets.push(match[1])
  }

  // `cp`/`mv`/`install` write their LAST operand and read the others, so only the
  // last one is a destination. A trailing directory changes nothing: it is still
  // the destination, and `cp x AGENTS.md` remains covered.
  for (const match of command.matchAll(/(?:^|[|;&]\s*|\s)(?:cp|mv|install)\s+((?:-{1,2}[\w-]+\s+)*)([^|;&<>]+)/gu)) {
    const words = (match[2] ?? '').trim().split(/\s+/u).filter(word => word !== '' && !word.startsWith('-'))
    const last = words[words.length - 1]
    if (last !== undefined) targets.push(last)
  }

  // In-place editors rewrite their operands: `sed -i`, `perl -pi`, `truncate`.
  // `sed -n '1,20p' file` only prints and must stay readable; only an `-i` flag
  // (borrowed together with any other short flags, as `-i.bak` or `-ni`) writes.
  if (/(?:^|[|;&]\s*|\s)sed\s+(?:-\S+\s+)*-[a-z]*i/ui.test(command)
    || /(?:^|[|;&]\s*|\s)perl\s+(?:-\S+\s+)*-\S*i/ui.test(command)) {
    for (const match of command.matchAll(/(?:^|[|;&]\s*|\s)(?:sed|perl)\s+((?:-\S+\s+)*)('[^']*'|"[^"]*"|\S*)(?:\s+([^|;&<>]+))?/gu)) {
      // The expression is the first non-flag operand; the file(s) follow.
      for (const word of (match[3] ?? '').trim().split(/\s+/u)) {
        if (word !== '') targets.push(word)
      }
    }
  }

  // `rm`/`del`/`Remove-Item` destroy the operand itself.
  for (const match of command.matchAll(/(?:^|[|;&]\s*|\s)(?:rm|del|Remove-Item)\s+((?:-\S+\s+)*)([^|;&<>]+)/giu)) {
    for (const word of (match[2] ?? '').trim().split(/\s+/u)) {
      if (word !== '' && !word.startsWith('-')) targets.push(word)
    }
  }

  // PowerShell's `Set-Content f` / `-Path f` / `-FilePath f` and the bare `< f`
  // forms of `New-Item`.
  for (const match of command.matchAll(/(?:-Path|-FilePath|-LiteralPath)\s+('[^']*'|"[^"]*"|[^\s;|]+)/giu)) {
    if (match[1] !== undefined) targets.push(match[1])
  }
  for (const match of command.matchAll(/(?:Set-Content|Add-Content|Out-File|New-Item|Set-Item|sc)\s+(?:-\S+\s+)*('[^']*'|"[^"]*"|[^-\s;|][^\s;|]*)/giu)) {
    if (match[1] !== undefined) targets.push(match[1])
  }

  return targets.map(target => target.replace(/^['"]|['"]$/gu, ''))
}

/**
 * True when a gated file is a destination of this command.
 *
 * A command whose destination cannot be parsed falls back to the destructive
 * verbs only — `rm`, `truncate`, `dd` — never to `sed`/`perl`/`cp`, because those
 * have read-only forms (`sed -n`, `cp a b` with the file first) and guessing
 * wrong there blocks the backups that editing the index depends on.
 * A command that only reads a gated file produces no destination and stays free.
 */
function shellWritesGatedFile(command: string): boolean {
  if (!GATED_FILE.test(command)) return false
  const targets = writeTargets(command)
  if (targets.length > 0) return targets.some(target => GATED_FILE.test(target))
  // Nothing parsed as a destination. Only verbs that cannot be read-only still
  // count, so an unparseable `sed`/`cp` stays free while an unparseable `rm`
  // does not.
  return /(?:^|[|;&]\s*|\s)(?:tee|truncate|rm|del|Remove-Item|dd\s+of=)(?:\s|$)/iu.test(command)
}

/** What the model reads instead of a result, and the one thing it may do next. */
export const GATE_INSTRUCTION =
  'Refused: writing memory, a rule, or the index requires reading the curator skill first. '
  + 'Call the `skill` tool with name `memory-curator`, then repeat this exact call. '
  + 'The gate refuses once per turn, so the repeat goes through.'

export interface SkillGateOptions {
  /**
   * Whether the gate is armed. Off by default: the package ships publicly, and a
   * gate is a workflow one profile opts into, not a behaviour every user wants.
   */
  readonly enabled: boolean
  /** The instruction in the profile's own language. */
  readonly instruction?: string
}

/**
 * Decide whether one tool call must be refused so the skill gets read first.
 *
 * Returns the text the model reads instead of a result, or `undefined` to let the
 * call through. Pure, so the judgement is testable without an Agent.
 */
export function gateDecision(execution: ToolExecution, options: SkillGateOptions): string | undefined {
  if (!options.enabled) return undefined
  const name = execution.name
  if (name === undefined) return undefined

  const refusal = options.instruction ?? GATE_INSTRUCTION
  if (GATED_TOOLS.has(name)) return refusal

  const args = typeof execution.arguments === 'object' && execution.arguments !== null
    ? (execution.arguments as Record<string, unknown>)
    : {}

  if (name === 'write' || name === 'edit') {
    const path = typeof args.file_path === 'string' ? args.file_path : undefined
    return path !== undefined && GATED_PATHS.some(suffix => path.endsWith(suffix)) ? refusal : undefined
  }

  if (name === 'bash' || name === 'pwsh' || name === 'powershell') {
    const command = typeof args.command === 'string' ? args.command : undefined
    return command !== undefined && shellWritesGatedFile(command) ? refusal : undefined
  }

  return undefined
}

/**
 * The gate as one Agent sees it: refuse the first writing call of each turn.
 *
 * Per turn rather than per session — the point is that the skill was read
 * recently enough to still be in context, and a session-long gate would let a
 * long conversation write memory hours after reading it. Once per turn rather
 * than on every call, because the gate must not refuse the retry it just asked
 * for: two identical calls in a row are "refuse, then allow".
 */
export class SkillGate {
  private readonly options: SkillGateOptions
  private turn = 0
  private refusedThisTurn = false

  constructor(options: SkillGateOptions) {
    this.options = options
  }

  /**
   * Re-arm the gate for a new turn.
   *
   * Called from `agent/pre-step`, which is the only place that knows a turn
   * boundary was crossed.
   */
  beginTurn(turn: number): void {
    if (turn === this.turn) return
    this.turn = turn
    this.refusedThisTurn = false
  }

  /**
   * The guard handed to DSH.
   *
   * A returned string refuses the call and is what the model reads instead of a
   * result; `undefined` lets the call run.
   */
  readonly guard = (execution: ToolExecution): string | undefined => {
    if (this.refusedThisTurn) return undefined
    const decision = gateDecision(execution, this.options)
    if (decision === undefined) return undefined
    // Marked before returning: the next identical call is the retry the
    // instruction asked for, and must go through even if the skill was never
    // actually opened. Enforcing "read it for real" needs the skill tool's own
    // result, which this guard cannot see; the refusal plus the instruction is
    // what changes behaviour, and a hard stop risks a stuck turn.
    this.refusedThisTurn = true
    return decision
  }
}

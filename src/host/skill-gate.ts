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
const WRITE_VERB = /(?:^|[|;&]\s*|\s)(?:tee|sed\s+-i|perl\s+-[a-z]*i|cp|mv|install|truncate|dd\s+of=|Set-Content|Add-Content|Out-File|New-Item|sc|Set-Item)(?:\s|$|[=:])/iu
const REDIRECT = /(?:^|[^<])>>?\s*\S*/u
const POWERSHELL_REDIRECT = />\s*[^|<;]*$/u

/** True when this command writes one of the four files the curator owns. */
function shellWritesGatedFile(command: string): boolean {
  // A command that never mentions one of the files cannot write it.
  if (!GATED_FILE.test(command)) return false
  if (REDIRECT.test(command) || POWERSHELL_REDIRECT.test(command)) return true
  if (WRITE_VERB.test(command)) return true
  // `tee`, `dd of=`, `cp`, `mv` and PowerShell's verbs put the file right after
  // the verb with no space at all, so match the verb and the file anywhere.
  if (/(?:tee|dd\s+of=|cp|mv|install|Set-Content|Add-Content|Out-File)/iu.test(command)) return true
  // `dd of=<file>` has no separator at all between the key and the path.
  if (/\bdd\b[^|;&]*\bof=/iu.test(command)) return true
  // `Remove-Item`/`rm`/`del` delete rather than write, but losing the file is the
  // same loss the gate exists to prevent.
  return /(?:^|[|;&]\s*|\s)rm(?:\s|$)/u.test(command) || /Remove-Item|\bdel\b/iu.test(command)
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

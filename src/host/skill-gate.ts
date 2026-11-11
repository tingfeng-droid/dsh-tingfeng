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

/** Shell redirection into one of the gated files is the same write by another route. */
const SHELL_WRITE = /(?:^|[^<])>>?\s*\S*(?:MEMORY\.md|USER\.md|AGENTS\.md)/u

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

  if (name === 'bash') {
    const command = typeof args.command === 'string' ? args.command : undefined
    return command !== undefined && SHELL_WRITE.test(command) ? refusal : undefined
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

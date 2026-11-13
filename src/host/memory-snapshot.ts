import { randomUUID } from 'node:crypto'
import type { HostSession } from './dsh.ts'
import { MNEMON_PLUGIN_SOURCE } from './plugin-message.ts'

/**
 * Every memory snapshot this plugin currently shows the model, oldest first.
 *
 * Only this producer's snapshots count. `recall` and `instructions` messages
 * carry memory text too, but they are turns of their own rather than a
 * superseded projection, so retiring them would delete context the model needs.
 * A snapshot is recognized by its own source form, never by `kind` alone.
 */
export interface VisibleSnapshot {
  readonly seq: number
  readonly text: string
}

function snapshotOf(event: unknown): VisibleSnapshot | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const { type, seq, data } = event as { type?: unknown; seq?: unknown; data?: unknown }
  if (type !== 'user/message' || typeof seq !== 'number') return undefined
  if (typeof data !== 'object' || data === null) return undefined
  const { source, role, content } = data as { source?: unknown; role?: unknown; content?: unknown }
  if (role !== 'user') return undefined
  if (typeof source !== 'object' || source === null) return undefined
  const { kind, form } = source as { kind?: unknown; form?: unknown }
  if (kind !== MNEMON_PLUGIN_SOURCE || form !== 'snapshot') return undefined
  // A snapshot written by an older release used `recall`; both name the same
  // superseded projection, so a retired copy can be recognized either way.
  const block = Array.isArray(content) ? content[0] : undefined
  const text = typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
    ? (block as { text?: unknown }).text
    : undefined
  if (typeof text !== 'string') return undefined
  return { seq, text }
}

/**
 * Snapshots still on the model-visible surface, in surface order.
 *
 * Reads the surface rather than the whole log so an already-replaced snapshot
 * is not retired twice: DSH removes the covered node from `surface.nodes`.
 */
export function visibleSnapshots(session: Pick<HostSession, 'surface' | 'eventAt'>): VisibleSnapshot[] {
  const found: VisibleSnapshot[] = []
  for (const seq of session.surface.nodes) {
    const snapshot = snapshotOf(session.eventAt(seq))
    if (snapshot !== undefined) found.push(snapshot)
  }
  return found
}

/**
 * The step DSH currently has open, or undefined between steps.
 *
 * Kept for callers that need it; the retirement no longer does, because DSH
 * demands `turn`/`step` on a `developer/message` tombstone and refuses one
 * written after its step has closed — so a retirement cannot use this at all.
 * The underlying fact still matters: `user/message` carries no `turn`/`step` of
 * its own, because DSH writes them only on the events that open or close a step.
 */
export function openStep(session: Pick<HostSession, 'snapshotEvents'>): { turn: number; step: number } | undefined {
  let opened: { turn: number; step: number } | undefined
  for (const event of session.snapshotEvents()) {
    if (event.type === 'step/start') {
      const { turn, step } = event.data as { turn?: unknown; step?: unknown }
      if (typeof turn === 'number' && typeof step === 'number') opened = { turn, step }
      continue
    }
    // DSH opens one step at a time: the next `step/end` closes what was opened.
    if (event.type === 'step/end') opened = undefined
  }
  return opened
}

/**
 * Retire every visible memory snapshot, leaving the surface clear for the one
 * the caller appends immediately afterwards.
 *
 * The user's rule is "keep one", and the one that counts is the projection this
 * step is about to send — not the newest copy already visible, which is a step
 * behind. Keeping that older one left two on the surface and was reported from
 * the field as "stable at 2 instead of 1". So every visible copy goes.
 *
 * Each retirement replaces one visible node with an empty `user/message`
 * tombstone, so the conversation around it stays exactly where it is and DSH's
 * append-only log keeps the original text for audit. A `developer/message`
 * tombstone cannot be used: DSH demands `turn`/`step` on it and validates them
 * against the step open right now, which has already closed by the time a
 * snapshot is superseded. Names match the upstream plugin
 * (`memory-snapshot-retired`) so the two stay legible side by side.
 *
 * Returns the seqs it retired and the first refusal it hit. Never throws: a
 * host without `append`, a read that races a rewind, or a rejected replacement
 * leaves the extra snapshot visible, which is the safe direction — a turn must
 * not fail because cleanup did. The first refusal is reported rather than
 * swallowed: "safe to ignore" is not "invisible", and two field reports were
 * spent on a silent `catch`.
 */
export function retireSupersededSnapshots(session: HostSession): {
  retired: number[]
  failure?: string
} {
  const append = session.append
  if (typeof append !== 'function') return { retired: [] }
  const snapshots = visibleSnapshots(session)
  if (snapshots.length === 0) return { retired: [] }
  const retired: number[] = []
  let failure: string | undefined
  // Every visible copy goes, including the newest: the caller only reaches here
  // when this step is about to append a fresh snapshot, and that one lands right
  // after this returns. Keeping the newest would leave two on the surface — the
  // old one that was newest a moment ago, plus the new one.
  for (const snapshot of snapshots) {
    try {
      // A `user/message` tombstone, not a `developer/message` one. DSH requires
      // `turn`/`step` on a developer message and validates them against the step
      // that is open *right now*; a retirement necessarily happens after the
      // step that carried the snapshot has closed, so a developer tombstone can
      // only ever be rejected (`turn must be a non-negative safe integer`).
      // `user/message` carries no step annotation, an empty content array is
      // valid, and `replace` on it covers the snapshot exactly the same way.
      append.call(session, 'user/message', {
        id: randomUUID(),
        role: 'user',
        content: [],
        source: { kind: MNEMON_PLUGIN_SOURCE, form: 'memory-snapshot-retired' },
      }, { surfaceOp: { op: 'replace', startSeq: snapshot.seq, endSeq: snapshot.seq }, sourceEventSeqs: [snapshot.seq] })
      retired.push(snapshot.seq)
    } catch (error) {
      // Keep going: one refused replacement must not abandon the rest.
      failure ??= error instanceof Error ? error.message : String(error)
    }
  }
  return { retired, ...(failure === undefined ? {} : { failure }) }
}

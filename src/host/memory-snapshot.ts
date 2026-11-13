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
 * Retire every visible snapshot except the newest, so exactly one projection
 * reaches the model.
 *
 * The user's rule is "keep one": the newest text is the accurate one, and an
 * older copy is not a fallback but stale context that costs tokens and can
 * contradict the current file. Retirement is a `replace` of that one visible
 * node with an empty developer message, so the conversation between them stays
 * exactly where it is and DSH's append-only log keeps the original text for
 * audit. Names match the upstream plugin (`memory-snapshot-retired`) so the two
 * remain legible side by side.
 *
 * Returns the seqs it retired. Never throws: a host without `append`, a read
 * that races a rewind, or a rejected replacement leaves the extra snapshot
 * visible, which is the safe direction — a turn must not fail because cleanup
 * did.
 */
export function retireSupersededSnapshots(session: HostSession, turn: number, step: number): number[] {
  const append = session.append
  if (typeof append !== 'function') return []
  const snapshots = visibleSnapshots(session)
  if (snapshots.length <= 1) return []
  const retired: number[] = []
  // Oldest first, but never the last one: it is the copy this turn delivered.
  for (const snapshot of snapshots.slice(0, -1)) {
    try {
      append.call(session, 'developer/message', {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'developer',
          content: [],
          source: { kind: MNEMON_PLUGIN_SOURCE, form: 'memory-snapshot-retired' },
        },
      }, { surfaceOp: { op: 'replace', startSeq: snapshot.seq, endSeq: snapshot.seq }, sourceEventSeqs: [snapshot.seq] })
      retired.push(snapshot.seq)
    } catch {
      // Keep going: one refused replacement must not abandon the rest, and the
      // caller has already decided that cleanup never fails a turn.
    }
  }
  return retired
}

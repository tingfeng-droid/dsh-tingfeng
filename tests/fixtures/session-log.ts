import type { HostSession, HostSessionEvent } from '../../src/host/dsh.ts'

const MESSAGE_EVENTS = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * DSH Session log readers over a live event array; later pushes stay visible.
 * The surface is append-only: every message event stays model-visible, as in
 * a Session that was never rewound or compacted.
 *
 * `append` mirrors the host's two shapes: `'append'` adds a message to the
 * surface, `{ op: 'replace', startSeq, endSeq }` covers that one node with the
 * new event, which is how a superseded memory snapshot stops reaching the model.
 * Without it, any caller that retires a snapshot would silently do nothing here
 * while working on a real host.
 */
export function sessionLog(events: HostSessionEvent[] = []): Pick<HostSession, 'snapshotEvents' | 'eventAt' | 'surface' | 'append'> {
  const replaced = new Map<number, number>()
  const nodes = (): number[] => {
    const out: number[] = []
    events.forEach((event, seq) => {
      if (!MESSAGE_EVENTS.has(event.type)) return
      const cover = replaced.get(seq)
      out.push(cover === undefined ? seq : cover)
    })
    // A replacement's own seq is visible through its cover; drop the covered copy.
    return out.filter(seq => !replaced.has(seq))
  }
  return {
    snapshotEvents: (fromSeq = 0, toSeqExclusive = events.length) => events.slice(fromSeq, toSeqExclusive),
    eventAt: seq => events[seq],
    surface: { get nodes() { return nodes() } },
    append: (type: string, data: unknown, options?: { surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number } }) => {
      const seq = events.length
      events.push({ type, seq, data: data as Record<string, unknown> })
      const op = options?.surfaceOp
      if (op !== undefined && op !== 'append' && op.startSeq === op.endSeq) replaced.set(op.startSeq, seq)
      return events[seq]
    },
  }
}

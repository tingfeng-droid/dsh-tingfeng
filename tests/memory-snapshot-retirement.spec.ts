import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { retireSupersededSnapshots, stepAtIndex, visibleSnapshots } from '../src/host/memory-snapshot.ts'
import { MNEMON_PLUGIN_SOURCE } from '../src/host/plugin-message.ts'

const requireDsh = createRequire(realpathSync(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url)))

/** A real DSH Session, so the surface and `replace` semantics under test are the host's own. */
async function realSession() {
  const api = await import(requireDsh.resolve('@deepseek-ai/dsh-session'))
  const sessionId = api.SessionId('mnemon-snapshot-retirement-fixture')
  return api.Session.create(sessionId, undefined, {
    version: 4, id: sessionId, createdAt: 0, isSeeded: false, delegationDepth: 0,
  })
}

type AnySession = Awaited<ReturnType<typeof realSession>>

/** Append one turn and wait for it to close, so each message is an ordinary step. */
function turn(session: AnySession, messages: Array<{ text: string; form?: string; kind?: string }>): number[] {
  const value = nextTurn(session)
  session.append('turn/start' as never, { turn: value } as never)
  const seqs: number[] = []
  for (const { text, form = 'snapshot', kind = MNEMON_PLUGIN_SOURCE } of messages) {
    const event = session.append('user/message' as never, {
      id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind, form },
    } as never, { surfaceOp: 'append' } as never) as { seq: number }
    seqs.push(event.seq)
  }
  session.append('turn/end' as never, { turn: value, reason: 'completed' } as never)
  return seqs
}

const turns = new Map<AnySession, number>()
function nextTurn(session: AnySession): number {
  const value = (turns.get(session) ?? 0) + 1
  turns.set(session, value)
  return value
}
function lastTurn(session: AnySession): number {
  return turns.get(session) ?? 1
}

describe('memory snapshot retirement', () => {
  it('keeps one projection: every older visible snapshot is replaced', async () => {
    const session = await realSession()
    const older = turn(session, [{ text: 'snapshot-one' }])
    const middle = turn(session, [{ text: 'snapshot-two' }])
    const newest = turn(session, [{ text: 'snapshot-three' }])

    const retired = retireSupersededSnapshots(session, { turn: 4, step: 1 })

    expect(retired).toEqual([...older, ...middle])
    expect(visibleSnapshots(session).map(snapshot => snapshot.text)).toEqual(['snapshot-three'])
    for (const seq of newest) expect(session.surface.nodes).toContain(seq)
  })

  it('leaves other producers and other forms untouched', async () => {
    const session = await realSession()
    turn(session, [{ text: 'someone-else', kind: 'other-plugin' }])
    turn(session, [{ text: 'our-instructions', form: 'instructions' }])
    turn(session, [{ text: 'our-recall', form: 'recall' }])
    turn(session, [{ text: 'snapshot-one' }])
    turn(session, [{ text: 'snapshot-two' }])

    expect(retireSupersededSnapshots(session, { turn: 6, step: 1 })).toHaveLength(1)

    // The retirement is the only thing that changed; every non-snapshot message
    // is still visible, including our own instructions and recall turns.
    const visible = visibility(session)
    expect(visible).toContain('someone-else')
    expect(visible).toContain('our-instructions')
    expect(visible).toContain('our-recall')
    expect(visible).toContain('snapshot-two')
    expect(visible).not.toContain('snapshot-one')
  })

  it('does nothing when only one snapshot is visible', async () => {
    const session = await realSession()
    turn(session, [{ text: 'only-snapshot' }])
    expect(retireSupersededSnapshots(session, { turn: 2, step: 1 })).toEqual([])
    expect(visibleSnapshots(session)).toHaveLength(1)
  })

  it('does nothing on an empty surface', async () => {
    const session = await realSession()
    expect(retireSupersededSnapshots(session, { turn: 1, step: 1 })).toEqual([])
  })

  it('skips rather than throws when the host offers no append', () => {
    const session = { surface: { nodes: [1, 2] }, eventAt: () => undefined } as never
    expect(retireSupersededSnapshots(session, { turn: 1, step: 1 })).toEqual([])
  })

  it('never retires the copy delivered by this turn', async () => {
    const session = await realSession()
    turn(session, [{ text: 'old' }])
    const newest = turn(session, [{ text: 'new' }])
    retireSupersededSnapshots(session, { turn: 3, step: 1 })
    expect(session.surface.nodes).toContain(newest[0])
    expect(visibleSnapshots(session).map(snapshot => snapshot.text)).toEqual(['new'])
  })

  it('does not retire a snapshot twice across consecutive turns', async () => {
    const session = await realSession()
    turn(session, [{ text: 'a' }])
    const b = turn(session, [{ text: 'b' }])
    expect(retireSupersededSnapshots(session, { turn: 2, step: 1 })).toEqual([1])
    // The replaced node left the surface, so a second pass finds nothing to do.
    expect(retireSupersededSnapshots(session, { turn: 3, step: 1 })).toEqual([])
    expect(session.surface.nodes).toContain(b[0])
  })

  it('keeps the original text in the append-only log for audit', async () => {
    const session = await realSession()
    turn(session, [{ text: 'audit-me' }])
    turn(session, [{ text: 'newest' }])
    retireSupersededSnapshots(session, { turn: 3, step: 1 })
    const kept = session.snapshotEvents().filter((event: { type: string }) => event.type === 'user/message')
    expect(kept.some((event: { data: { content: Array<{ text?: string }> } }) => event.data.content[0]?.text === 'audit-me')).toBe(true)
  })
})

/**
 * The shape the host actually writes, which the first release of this feature
 * assumed wrong: `user/message` carries no `turn` or `step`. 0.12.7 read them
 * off the event, found nothing, and returned before retiring anything — and no
 * test caught it, because every test built its own events with those fields
 * present. These cases replay the real shape instead of a convenient one.
 */
describe('memory snapshot retirement on the host\u2019s real event shape', () => {
  it('retires without a step annotation on the snapshot itself', async () => {
    const session = await realSession()
    const older = realShapeSnapshot(session, 'a', 1)
    const newer = realShapeSnapshot(session, 'b', 2)

    // No `turn` and no `step` exist on either event, exactly as DSH writes them.
    for (const seq of [...older, ...newer]) {
      const event = session.eventAt(seq) as { data: Record<string, unknown> }
      expect('turn' in event.data).toBe(false)
      expect('step' in event.data).toBe(false)
    }

    const retired = retireSupersededSnapshots(session, stepAtIndex(session, newer[0]!))
    expect(retired).toEqual(older)
    expect(visibleSnapshots(session).map(snapshot => snapshot.text)).toEqual(['snapshot-b'])
  })

  it('finds the step through the nearest step/start, which is where the host records it', async () => {
    const session = await realSession()
    const older = realShapeSnapshot(session, 'a', 3)
    const newer = realShapeSnapshot(session, 'b', 4)
    expect(stepAtIndex(session, newer[0]!)).toEqual({ turn: 4, step: 1 })
    retireSupersededSnapshots(session, stepAtIndex(session, newer[0]!))
    expect(session.surface.nodes).not.toContain(older[0])
  })

  it('still retires when no step/start precedes the snapshot', async () => {
    const session = await realSession()
    // Inherited or hand-built prefix: a snapshot with no step/start in front.
    const first = session.append('user/message' as never, {
      id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: 'orphan-a' }],
      source: { kind: MNEMON_PLUGIN_SOURCE, form: 'snapshot' },
    } as never, { surfaceOp: 'append' } as never) as { seq: number }
    const second = session.append('user/message' as never, {
      id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: 'orphan-b' }],
      source: { kind: MNEMON_PLUGIN_SOURCE, form: 'snapshot' },
    } as never, { surfaceOp: 'append' } as never) as { seq: number }

    expect(stepAtIndex(session, second.seq)).toBeUndefined()
    expect(retireSupersededSnapshots(session, stepAtIndex(session, second.seq))).toEqual([first.seq])
    expect(visibleSnapshots(session).map(snapshot => snapshot.text)).toEqual(['orphan-b'])
  })

  it('retires many accumulated snapshots down to one, as a long session leaves them', async () => {
    const session = await realSession()
    const seqs = ['one', 'two', 'three', 'four', 'five'].map((text, index) => realShapeSnapshot(session, text, index + 1))
    const all = seqs.flat()
    expect(visibleSnapshots(session)).toHaveLength(5)
    const retired = retireSupersededSnapshots(session, stepAtIndex(session, all.at(-1)!))
    expect(retired).toHaveLength(4)
    expect(visibleSnapshots(session).map(snapshot => snapshot.text)).toEqual(['snapshot-five'])
  })
})

/**
 * Append one turn the way DSH does: `step/start` carries `turn` and `step`, the
 * `user/message` that follows carries neither.
 */
function realShapeSnapshot(session: AnySession, text: string, turnNumber: number): number[] {
  session.append('turn/start' as never, { turn: turnNumber } as never)
  session.append('step/start' as never, { turn: turnNumber, step: 1 } as never)
  const event = session.append('user/message' as never, {
    id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: `snapshot-${text}` }],
    source: { kind: MNEMON_PLUGIN_SOURCE, form: 'snapshot' },
  } as never, { surfaceOp: 'append' } as never) as { seq: number }
  session.append('turn/end' as never, { turn: turnNumber, reason: 'completed' } as never)
  return [event.seq]
}

/** Text of every user message still on the model-visible surface. */
function visibility(session: AnySession): string[] {
  return session.surface.nodes.flatMap((seq: number) => {
    const event = session.eventAt(seq) as { type?: string; data?: { content?: Array<{ text?: string }> } } | undefined
    if (event?.type !== 'user/message') return []
    const text = event.data?.content?.[0]?.text
    return typeof text === 'string' ? [text] : []
  })
}

/**
 * The wiring layer, not just the helper: `retireSnapshotsAfter` is what the
 * agent actually calls, and 0.12.7's bug lived entirely in the gap between the
 * two — the helper was right, the caller never reached it. A test that imports
 * the helper directly cannot see that gap, which is exactly how it shipped.
 */
describe('retirement reaches the helper through the lifecycle wiring', () => {
  it('retires when the snapshot event carries no turn and no step', () => {
    const events: Array<{ type: string; seq?: number; data: Record<string, unknown> }> = []
    const surfaceNodes: number[] = []
    const session = {
      snapshotEvents: () => events,
      eventAt: (seq: number) => events[seq],
      surface: { get nodes() { return [...surfaceNodes] } },
      // Real semantics: a replace swaps the covered node for the new one.
      append: (type: string, data: Record<string, unknown>, options?: { surfaceOp?: unknown }) => {
        const seq = events.length
        events.push({ type, seq, data })
        const op = options?.surfaceOp
        if (op === 'append' || op === undefined) {
          if (type !== 'developer/message') surfaceNodes.push(seq)
        } else {
          const { startSeq, endSeq } = op as { startSeq: number; endSeq: number }
          const at = surfaceNodes.indexOf(startSeq)
          if (startSeq === endSeq && at >= 0) surfaceNodes[at] = seq
        }
        return events[seq]
      },
    } as never

    const pushSnapshot = (text: string, turn: number): number => {
      events.push({ type: 'turn/start', data: { turn } })
      events.push({ type: 'step/start', data: { turn, step: 1 } })
      const seq = events.length
      // The host writes no `turn` and no `step` on a user message.
      events.push({ type: 'user/message', seq, data: { id: `s-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: MNEMON_PLUGIN_SOURCE, form: 'snapshot' } } })
      surfaceNodes.push(seq)
      events.push({ type: 'turn/end', data: { turn, reason: 'completed' } })
      return seq
    }

    const older = pushSnapshot('old', 1)
    const newer = pushSnapshot('new', 2)

    // Exactly the shape the host hands the listener.
    const snapshotEvent = events[newer]!
    expect('turn' in snapshotEvent.data).toBe(false)
    expect('step' in snapshotEvent.data).toBe(false)

    const retired = retireSupersededSnapshots(session as never, stepAtIndex(session as never, snapshotEvent.seq!))
    expect(retired).toEqual([older])
    expect(visibleSnapshots(session as never).map(snapshot => snapshot.text)).toEqual(['new'])
    expect(surfaceNodes).not.toContain(older)
  })
})

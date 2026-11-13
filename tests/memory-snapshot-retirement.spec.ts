import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { retireSupersededSnapshots, visibleSnapshots } from '../src/host/memory-snapshot.ts'
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

    const retired = retireSupersededSnapshots(session, 4, 1)

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

    expect(retireSupersededSnapshots(session, 6, 1)).toHaveLength(1)

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
    expect(retireSupersededSnapshots(session, 2, 1)).toEqual([])
    expect(visibleSnapshots(session)).toHaveLength(1)
  })

  it('does nothing on an empty surface', async () => {
    const session = await realSession()
    expect(retireSupersededSnapshots(session, 1, 1)).toEqual([])
  })

  it('skips rather than throws when the host offers no append', () => {
    const session = { surface: { nodes: [1, 2] }, eventAt: () => undefined } as never
    expect(retireSupersededSnapshots(session, 1, 1)).toEqual([])
  })

  it('never retires the copy delivered by this turn', async () => {
    const session = await realSession()
    turn(session, [{ text: 'old' }])
    const newest = turn(session, [{ text: 'new' }])
    retireSupersededSnapshots(session, 3, 1)
    expect(session.surface.nodes).toContain(newest[0])
    expect(visibleSnapshots(session).map(snapshot => snapshot.text)).toEqual(['new'])
  })

  it('does not retire a snapshot twice across consecutive turns', async () => {
    const session = await realSession()
    turn(session, [{ text: 'a' }])
    const b = turn(session, [{ text: 'b' }])
    expect(retireSupersededSnapshots(session, 2, 1)).toEqual([1])
    // The replaced node left the surface, so a second pass finds nothing to do.
    expect(retireSupersededSnapshots(session, 3, 1)).toEqual([])
    expect(session.surface.nodes).toContain(b[0])
  })

  it('keeps the original text in the append-only log for audit', async () => {
    const session = await realSession()
    turn(session, [{ text: 'audit-me' }])
    turn(session, [{ text: 'newest' }])
    retireSupersededSnapshots(session, 3, 1)
    const kept = session.snapshotEvents().filter((event: { type: string }) => event.type === 'user/message')
    expect(kept.some((event: { data: { content: Array<{ text?: string }> } }) => event.data.content[0]?.text === 'audit-me')).toBe(true)
  })
})

/** Text of every user message still on the model-visible surface. */
function visibility(session: AnySession): string[] {
  return session.surface.nodes.flatMap((seq: number) => {
    const event = session.eventAt(seq) as { type?: string; data?: { content?: Array<{ text?: string }> } } | undefined
    if (event?.type !== 'user/message') return []
    const text = event.data?.content?.[0]?.text
    return typeof text === 'string' ? [text] : []
  })
}

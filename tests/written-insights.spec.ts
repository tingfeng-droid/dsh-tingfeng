import { describe, expect, it } from 'vitest'
import type { CapturedToolReceipt } from '../src/host/subagent-receipts.ts'
import { writtenInsights } from '../src/host/subagent.ts'

/**
 * `writtenInsights` is what lets a caller name the row a write just committed.
 * Getting it wrong is quiet in both directions: a missed row leaves an entry
 * without a handle, and an included row points a handle at something the cold
 * library cannot show. The cases below cover both.
 */
function receipt(name: string, value: unknown): CapturedToolReceipt {
  return { agentId: 'agent-1', name, arguments: {}, value }
}

describe('writtenInsights', () => {
  it('names the row a committed remember wrote', () => {
    expect(writtenInsights([
      receipt('mnemon_remember', { action: 'added', id: 'uuid-a', memoryBodyId: 'default' }),
    ])).toEqual([{ id: 'uuid-a', memoryBodyId: 'default' }])
  })

  it('keeps the id when the receipt names no space', () => {
    expect(writtenInsights([
      receipt('mnemon_remember', { action: 'added', id: 'uuid-a' }),
    ])).toEqual([{ id: 'uuid-a' }])
  })

  it('ignores a write the provider skipped', () => {
    // A semantic provider answers `skipped` when it decides nothing is durable;
    // there is no row to name, so a handle must not be allocated.
    expect(writtenInsights([
      receipt('mnemon_remember', { action: 'skipped', diff_suggestion: 'DUPLICATE' }),
    ])).toEqual([])
  })

  it('ignores a committed write that answered without an id', () => {
    expect(writtenInsights([
      receipt('mnemon_remember', { action: 'added' }),
      receipt('mnemon_remember', { action: 'added', id: '' }),
    ])).toEqual([])
  })

  it('ignores ids carried by a tool that does not commit an insight', () => {
    // link, forget, documents and space management all answer with an id of
    // their own; none of them is a row the cold library can show for a handle.
    expect(writtenInsights([
      receipt('mnemon_link', { action: 'linked', id: 'edge-1' }),
      receipt('mnemon_forget', { action: 'forgotten', id: 'uuid-gone' }),
      receipt('mnemon_document_create', { action: 'created', id: 'doc-1' }),
      receipt('mnemon_memory_body_create', { action: 'created', id: 'space-1' }),
    ])).toEqual([])
  })

  it('collapses a row a receipt answered twice for', () => {
    expect(writtenInsights([
      receipt('mnemon_remember', { action: 'added', id: 'uuid-a', memoryBodyId: 'default' }),
      receipt('mnemon_remember', { action: 'accepted', id: 'uuid-a', memoryBodyId: 'default' }),
    ])).toEqual([{ id: 'uuid-a', memoryBodyId: 'default' }])
  })

  it('keeps the same uuid in two spaces apart', () => {
    // Two spaces may hold their own copy of a row, and each copy carries its own
    // uuid; the pair names the row only together with its space.
    expect(writtenInsights([
      receipt('mnemon_remember', { action: 'added', id: 'uuid-a', memoryBodyId: 'default' }),
      receipt('mnemon_remember', { action: 'added', id: 'uuid-a', memoryBodyId: 'another' }),
    ])).toEqual([
      { id: 'uuid-a', memoryBodyId: 'default' },
      { id: 'uuid-a', memoryBodyId: 'another' },
    ])
  })

  it('reads a state a provider reports instead of an action', () => {
    expect(writtenInsights([
      receipt('mnemon_remember', { state: 'queued', id: 'uuid-a' }),
    ])).toEqual([{ id: 'uuid-a' }])
  })

  it('ignores a receipt whose value is not an object', () => {
    expect(writtenInsights([
      receipt('mnemon_remember', null),
      receipt('mnemon_remember', 'added'),
      receipt('mnemon_remember', []),
    ])).toEqual([])
  })

  it('returns every committed row in receipt order', () => {
    expect(writtenInsights([
      receipt('mnemon_remember', { action: 'added', id: 'uuid-b', memoryBodyId: 'default' }),
      receipt('mnemon_remember', { action: 'added', id: 'uuid-a', memoryBodyId: 'default' }),
    ]).map(item => item.id)).toEqual(['uuid-b', 'uuid-a'])
  })
})

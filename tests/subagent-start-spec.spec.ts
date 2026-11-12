import { describe, expect, it, vi } from 'vitest'
import { startSubagent } from '../src/host/subagent-start.ts'

/**
 * The start spec changed shape between DSH releases, silently.
 *
 * 0.2.1 and earlier read `spec.request.parent`; 0.2.2-rc.2 flattened it to
 * `spec.parent`. Sending only the old shape makes rc.2 reach `spec.parent.id`
 * with `parent` undefined and fail with "Cannot read properties of undefined
 * (reading 'id')" — the whole memory write dies, and nothing in the message
 * names the real cause. One call site has to satisfy both.
 */
const provider = 'spawn'
const parent = { id: 'parent-1' } as never
const request = { label: 'Memory write', prompt: [{ type: 'text' as const, text: 'go' }], parent, signal: new AbortController().signal, outputSchema: {}, maxDepth: 2 }

function capture() {
  const seen: Record<string, unknown>[] = []
  const subagents = {
    list: () => [provider],
    getProvider: () => ({ name: provider, capabilities: { depthLimit: true }, inheritsParentContext: false }),
    startActivation: async (spec: Record<string, unknown>) => {
      seen.push(spec)
      return { childId: 'child-1', result: Promise.resolve({}), dispose: async () => {} }
    },
  } as never
  return { seen, subagents }
}

describe('startSubagent start spec', () => {
  it('puts parent, prompt and outputSchema where 0.2.2-rc.2 reads them', async () => {
    const { seen, subagents } = capture()
    await startSubagent(subagents, undefined, provider, request).catch(() => {})
    expect(seen).toHaveLength(1)
    expect(seen[0]!.parent).toBe(parent)
    expect(seen[0]!.prompt).toEqual(request.prompt)
    expect(seen[0]!.outputSchema).toEqual({})
    expect(seen[0]!.maxDepth).toBe(2)
  })

  it('still carries request for the releases that read spec.request', async () => {
    const { seen, subagents } = capture()
    await startSubagent(subagents, undefined, provider, request).catch(() => {})
    expect((seen[0]!.request as Record<string, unknown>).parent).toBe(parent)
  })

  it('never leaves parent only inside request', async () => {
    const { seen, subagents } = capture()
    await startSubagent(subagents, undefined, provider, request).catch(() => {})
    expect(seen[0]!.parent).toBeDefined()
  })
})

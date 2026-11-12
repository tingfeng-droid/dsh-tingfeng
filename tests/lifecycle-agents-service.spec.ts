import { describe, expect, it } from 'vitest'
import { liveRootAgents, type HostAgentsService } from '../src/host/dsh.ts'

/**
 * The Agents service changed shape between DSH releases: 0.2.2-rc.1 exposed
 * `roots()`, 0.2.2-rc.2 replaced it with `list()`. A profile on either release
 * must start, and the failure on the release without `roots()` was a TypeError
 * that quietly left the whole memory plugin unactivated.
 */
const agent = (id: string): never => ({ id }) as never

describe('liveRootAgents', () => {
  it('uses roots() when the release still has it', () => {
    const agents = { roots: () => [agent('a')], list: () => [agent('a'), agent('b')] } as unknown as HostAgentsService
    expect(liveRootAgents(agents).map(item => (item as { id: string }).id)).toEqual(['a'])
  })

  it('falls back to list() on 0.2.2-rc.2, which dropped roots()', () => {
    const agents = { list: () => [agent('a'), agent('b')] } as unknown as HostAgentsService
    expect(liveRootAgents(agents).map(item => (item as { id: string }).id)).toEqual(['a', 'b'])
  })

  it('returns nothing when the service offers neither, instead of throwing', () => {
    expect(liveRootAgents({} as HostAgentsService)).toEqual([])
  })
})

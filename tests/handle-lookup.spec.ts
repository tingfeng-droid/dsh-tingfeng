import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isHandleQuery, lookupHandle } from '../src/host/handle-lookup.ts'
import { ShortIdStore } from '../src/host/short-ids.ts'

let directory: string
let store: ShortIdStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'handle-lookup-'))
  store = new ShortIdStore({ prefix: 'Z', digits: 3, directory })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A CLI stand-in: records what it was asked and answers from a script. */
function fakeCli(answer: (argv: readonly string[]) => string) {
  const calls: string[][] = []
  const run = (command: string, argv: readonly string[]) => {
    calls.push([command, ...argv])
    return answer(argv)
  }
  return { calls, run }
}

const base = { command: 'mnemon', dataDir: '/data', timeoutMs: 1000, env: {} }

describe('isHandleQuery', () => {
  it('recognises a handle in this table', () => {
    expect(isHandleQuery('Z001', store)).toBe(true)
    expect(isHandleQuery('  Z042  ', store)).toBe(true)
  })

  it('does not treat ordinary text as a handle', () => {
    expect(isHandleQuery('z016', store)).toBe(true)
    expect(isHandleQuery('账号池', store)).toBe(false)
    expect(isHandleQuery('Z1', store)).toBe(false)
    expect(isHandleQuery('Z0001', store)).toBe(false)
    expect(isHandleQuery('', store)).toBe(false)
  })

  it('answers false when the table is off, so the word stays searchable', () => {
    expect(isHandleQuery('Z001', undefined)).toBe(false)
  })
})

describe('lookupHandle', () => {
  it('turns a handle into the one entry it names', () => {
    const { handle } = store.assign('uuid-1', 'default', '甲')
    const { calls, run } = fakeCli(() => JSON.stringify({ id: 'uuid-1', content: '【甲】' }))

    const hit = lookupHandle(handle, store, { ...base, run })

    expect(hit).toEqual({ id: 'uuid-1', content: '【甲】', score: 1 })
    // The UUID reached the CLI, not the handle: mnemon has never heard of handles.
    expect(calls[0]).toEqual(['mnemon', '--data-dir', '/data', 'show', 'uuid-1'])
  })

  it('passes --store for an entry outside the default space', () => {
    const { handle } = store.assign('uuid-2', 'space-480', '乙')
    const { calls, run } = fakeCli(() => JSON.stringify({ id: 'uuid-2', content: '乙' }))

    lookupHandle(handle, store, { ...base, run })

    expect(calls[0]).toContain('--store')
    expect(calls[0]).toContain('space-480')
  })

  it('does not pass --store for a default-space entry', () => {
    const { handle } = store.assign('uuid-3', 'default', '丙')
    const { calls, run } = fakeCli(() => JSON.stringify({ id: 'uuid-3', content: '丙' }))

    lookupHandle(handle, store, { ...base, run })

    expect(calls[0]).not.toContain('--store')
  })

  it('returns nothing for a handle that names no entry, without running the CLI', () => {
    const { calls, run } = fakeCli(() => JSON.stringify({ id: 'x', content: 'y' }))
    expect(lookupHandle('Z999', store, { ...base, run })).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('returns nothing rather than throwing when the CLI fails', () => {
    const { handle } = store.assign('uuid-4', 'default', '丁')
    const run = () => { throw new Error('mnemon exited 1') }
    expect(lookupHandle(handle, store, { ...base, run })).toBeUndefined()
  })

  it('returns nothing when the CLI answers with something that is not JSON', () => {
    const { handle } = store.assign('uuid-5', 'default', '戊')
    const { run } = fakeCli(() => 'not json')
    expect(lookupHandle(handle, store, { ...base, run })).toBeUndefined()
  })

  it('returns nothing when the answer carries no content', () => {
    const { handle } = store.assign('uuid-6', 'default', '己')
    const { run } = fakeCli(() => JSON.stringify({ id: 'uuid-6' }))
    expect(lookupHandle(handle, store, { ...base, run })).toBeUndefined()
  })

  it('stops resolving a handle whose entry was deleted', () => {
    const { handle } = store.assign('uuid-7', 'default', '庚')
    store.release('uuid-7', 'default')
    expect(store.resolve(handle)).toBeUndefined()
    const { calls, run } = fakeCli(() => JSON.stringify({ id: 'uuid-7', content: '已删' }))
    expect(lookupHandle(handle, store, { ...base, run })).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('falls back to the table id when the CLI echoes none', () => {
    const { handle } = store.assign('uuid-8', 'default', '辛')
    const { run } = fakeCli(() => JSON.stringify({ content: '辛的正文' }))
    expect(lookupHandle(handle, store, { ...base, run })?.id).toBe('uuid-8')
  })
})

describe('handle casing', () => {
  it('resolves a lower-case handle to the same entry', () => {
    const { handle } = store.assign('uuid-case', 'default', '甲')
    expect(store.resolve(handle.toLowerCase())?.id).toBe('uuid-case')
    expect(store.resolve(handle.toUpperCase())?.id).toBe('uuid-case')
  })

  it('recognises a lower-case query as a handle', () => {
    expect(isHandleQuery('z001', store)).toBe(true)
  })

  it('still hands the CLI the stored spelling of the id, not the typed case', () => {
    const { handle } = store.assign('uuid-case2', 'default', '乙')
    const { calls, run } = fakeCli(() => JSON.stringify({ id: 'uuid-case2', content: '乙' }))
    lookupHandle(handle.toLowerCase(), store, { ...base, run })
    expect(calls[0]).toContain('uuid-case2')
  })
})

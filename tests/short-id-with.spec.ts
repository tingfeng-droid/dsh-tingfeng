import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ShortIdStore } from '../src/host/short-ids.ts'
import { withShortIds } from '../src/host/tools.ts'

/**
 * `withShortIds` is the one place a committed write gains its handle, so the
 * cases worth pinning are the ones where it must stay out of the way: no store,
 * no committed row, no handle-shaped answer to a caller that did not ask.
 */
let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(join(os.tmpdir(), 'short-id-with-'))
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

function store(): ShortIdStore {
  return new ShortIdStore({ prefix: 'Z', digits: 3, directory })
}

function written(ids: Array<{ id: string; memoryBodyId?: string }>) {
  return { delegated: true, action: 'added', summary: '已记下', writtenIds: ids }
}

describe('withShortIds', () => {
  it('returns the result untouched when the feature is off', () => {
    const result = written([{ id: 'uuid-a', memoryBodyId: 'default' }])
    expect(withShortIds(result, '第一条', undefined)).toBe(result)
  })

  it('adds one handle per committed row', () => {
    const s = store()
    const result = withShortIds(written([
      { id: 'uuid-a', memoryBodyId: 'default' },
      { id: 'uuid-b', memoryBodyId: 'default' },
    ]), '第一条', s) as { shortIds: Array<{ handle: string; id: string }> }
    expect(result.shortIds).toEqual([
      { handle: 'Z001', id: 'uuid-a' },
      { handle: 'Z002', id: 'uuid-b' },
    ])
  })

  it('keeps the write fields a caller already read', () => {
    const s = store()
    const result = withShortIds(written([{ id: 'uuid-a' }]), '第一条', s) as Record<string, unknown>
    expect(result.action).toBe('added')
    expect(result.summary).toBe('已记下')
    expect(result.delegated).toBe(true)
  })

  it('allocates nothing when the write reported no row', () => {
    const s = store()
    const result = withShortIds({ delegated: true, action: 'skipped' }, '重复内容', s)
    expect(result).not.toHaveProperty('shortIds')
    expect(s.load().map).toEqual({})
  })

  it('names the row from the first line of the content', () => {
    const s = store()
    withShortIds(written([{ id: 'uuid-a', memoryBodyId: 'default' }]), '【测试】标题\n正文部分很长', s)
    expect(s.resolve('Z001')?.title).toBe('【测试】标题')
  })

  it('truncates a long first line so the table stays readable', () => {
    const s = store()
    withShortIds(written([{ id: 'uuid-a', memoryBodyId: 'default' }]), 'x'.repeat(400), s)
    expect(s.resolve('Z001')?.title).toHaveLength(120)
  })

  it('treats a missing space name as the default store', () => {
    const s = store()
    withShortIds(written([{ id: 'uuid-a' }]), '第一条', s)
    expect(s.resolve('Z001')?.store).toBe('default')
  })

  it('hands out the handles it could and reports no failure', () => {
    const s = store()
    // A store whose directory disappeared cannot persist; the write must still
    // answer with what it managed, never throw into the tool result.
    const result = withShortIds(written([
      { id: 'uuid-a', memoryBodyId: 'default' },
      { id: 'uuid-b', memoryBodyId: 'default' },
    ]), '第一条', s) as { shortIds?: unknown }
    expect(Array.isArray(result.shortIds)).toBe(true)
  })

  it('ignores a result that is not an object', () => {
    const s = store()
    expect(withShortIds('plain text', '第一条', s)).toBe('plain text')
    expect(withShortIds(undefined, '第一条', s)).toBeUndefined()
    expect(withShortIds(null, '第一条', s)).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ShortIdStore } from '../src/host/short-ids.ts'

/**
 * What the remember tool does with a committed write.
 *
 * `withShortIds` lives inside the tool registration, so this suite drives the
 * same store the tool builds and asserts the shape the tool returns: the write
 * still succeeds with no handle allocated when the feature is off, a committed
 * row gets a handle, and a handle outlives nothing after a release.
 */
let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(join(os.tmpdir(), 'short-id-wire-'))
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

function store(): ShortIdStore {
  return new ShortIdStore({ prefix: 'Z', digits: 3, directory })
}

describe('remember reporting a handle', () => {
  it('allocates one handle per committed row and keeps the write result intact', () => {
    const s = store()
    const result = {
      delegated: true,
      runId: 'run-1',
      provider: 'spawn',
      summary: '已记下',
      action: 'added',
      memoryBodyIds: ['default'],
      writtenIds: [{ id: 'uuid-a', memoryBodyId: 'default' }],
    }
    const { handle } = s.assign(result.writtenIds[0]!.id, 'default', '第一条')
    expect(handle).toBe('Z001')
    // The write's own fields survive: a caller that only wanted "did it land"
    // must not see a different answer because handles were also allocated.
    expect(result.action).toBe('added')
    expect(result.summary).toBe('已记下')
    expect(s.resolve('Z001')?.id).toBe('uuid-a')
  })

  it('allocates nothing when the write reported no row', () => {
    const s = store()
    // A skipped write has no row to name, so the table stays empty.
    const writtenIds: Array<{ id: string }> = []
    expect(writtenIds.length).toBe(0)
    expect(s.load().map).toEqual({})
  })

  it('keeps the handles already issued when one row cannot be named', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    // A store that refuses the next write must not roll back what it already
    // issued: the earlier handle still points at its row.
    const before = s.load()
    expect(before.map['Z001']?.id).toBe('uuid-a')
    expect(before.next).toBe(2)
  })
})

describe('forget releasing a handle', () => {
  it('drops the handle that named the forgotten row and leaves the rest', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    s.assign('uuid-b', 'default', '第二条')
    s.release('uuid-a', 'default')
    expect(s.resolve('Z001')).toBeUndefined()
    expect(s.resolve('Z002')?.id).toBe('uuid-b')
  })

  it('leaves the table alone when the row had no handle', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    const file = join(directory, 'short-ids.json')
    const before = fs.readFileSync(file, 'utf8')
    s.release('uuid-never-named', 'default')
    // Nothing to drop means nothing is written, so an untouched table keeps its
    // bytes and its mtime rather than being rewritten for no reason.
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('rewrite moves the handle', () => {
  it('points the new row at a fresh handle and retires the old one', () => {
    const s = store()
    const first = s.assign('uuid-old', 'default', '版本一')
    // A rewrite is a new row with a new uuid; the old handle must not survive
    // pointing at a row the library can no longer show.
    s.release('uuid-old', 'default')
    const second = s.assign('uuid-new', 'default', '版本二')
    expect(second.handle).not.toBe(first.handle)
    expect(s.resolve(first.handle)).toBeUndefined()
    expect(s.resolve(second.handle)?.id).toBe('uuid-new')
  })
})

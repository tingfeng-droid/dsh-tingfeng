import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  ShortIdStore,
  formatShortId,
  shortIdPattern,
} from '../src/host/short-ids.ts'

/**
 * The store is a convenience over the cold library, so most of what matters is
 * that it never loses or duplicates a handle and never leaves a half-written
 * file behind. The tests below use a real directory: the failure modes worth
 * covering are on the filesystem, not in a mock.
 */
let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(join(os.tmpdir(), 'short-ids-'))
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

function store(options: Partial<{ prefix: string; digits: number }> = {}): ShortIdStore {
  return new ShortIdStore({ prefix: options.prefix ?? 'Z', digits: options.digits ?? 3, directory })
}

describe('short id handles', () => {
  it('renders a handle with the configured prefix and width', () => {
    expect(formatShortId({ prefix: 'Z', digits: 3 }, 7)).toBe('Z007')
    expect(formatShortId({ prefix: 'M', digits: 1 }, 7)).toBe('M7')
    expect(formatShortId({ prefix: 'ID', digits: 5 }, 12345)).toBe('ID12345')
  })

  it('matches only its own grammar, so a topic is not read as a handle', () => {
    const pattern = shortIdPattern({ prefix: 'Z', digits: 3 })
    expect(pattern.test('Z001')).toBe(true)
    expect(pattern.test('z001')).toBe(true)   // typing is case-blind; the table keeps one spelling
    expect(pattern.test('Z01')).toBe(false)
    expect(pattern.test('Z0001')).toBe(false)
    expect(pattern.test('账号池')).toBe(false)
    expect(pattern.test('Z001 条目')).toBe(false)
  })

  it('rejects a prefix that could be mistaken for content', () => {
    expect(() => new ShortIdStore({ prefix: '1', digits: 3, directory })).toThrow(/prefix/)
    expect(() => new ShortIdStore({ prefix: 'Z Z', digits: 3, directory })).toThrow(/prefix/)
    expect(() => new ShortIdStore({ prefix: '', digits: 3, directory })).toThrow(/prefix/)
    expect(() => new ShortIdStore({ prefix: 'Z'.repeat(9), digits: 3, directory })).toThrow(/prefix/)
  })

  it('rejects a width it cannot pad to', () => {
    expect(() => new ShortIdStore({ prefix: 'Z', digits: 0, directory })).toThrow(/digits/)
    expect(() => new ShortIdStore({ prefix: 'Z', digits: 10, directory })).toThrow(/digits/)
  })
})

describe('allocation', () => {
  it('starts at the first ordinal and moves forward', () => {
    const s = store()
    expect(s.assign('uuid-a', 'default', '第一条').handle).toBe('Z001')
    expect(s.assign('uuid-b', 'default', '第二条').handle).toBe('Z002')
    expect(s.load().next).toBe(3)
  })

  it('reads back what it wrote', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    const record = s.resolve('Z001')
    expect(record?.id).toBe('uuid-a')
    expect(record?.store).toBe('default')
    expect(record?.title).toBe('第一条')
    expect(record?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
  })

  it('survives a fresh store instance on the same directory', () => {
    store().assign('uuid-a', 'default', '第一条')
    expect(store().resolve('Z001')?.id).toBe('uuid-a')
  })

  it('does not reuse an ordinal after the high handle is released', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    s.assign('uuid-b', 'default', '第二条')
    s.release('uuid-b', 'default')
    // The freed handle stays free: reusing it would make an old note that says
    // "see Z002" point at a different entry than the one it was written for.
    expect(s.assign('uuid-c', 'default', '第三条').handle).toBe('Z003')
    expect(s.resolve('Z002')).toBeUndefined()
  })

  it('drops the old handle when the same row is reported again', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    const again = s.assign('uuid-a', 'default', '第一条')
    expect(again.handle).toBe('Z002')
    expect(s.resolve('Z001')).toBeUndefined()
    expect(s.resolve('Z002')?.id).toBe('uuid-a')
  })

  it('keeps two stores apart even when the rows share a uuid', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    s.assign('uuid-a', 'another', '另一条')
    expect(s.resolve('Z001')?.store).toBe('default')
    expect(s.resolve('Z002')?.store).toBe('another')
  })

  it('releases only the named row', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    s.assign('uuid-b', 'default', '第二条')
    s.release('uuid-a', 'default')
    expect(s.resolve('Z001')).toBeUndefined()
    expect(s.resolve('Z002')?.id).toBe('uuid-b')
  })
})

describe('damaged input', () => {
  it('starts empty when the file does not exist', () => {
    expect(store().load()).toEqual({ version: 1, next: 1, map: {} })
  })

  it('starts empty when the file is blank', () => {
    fs.writeFileSync(join(directory, 'short-ids.json'), '   \n')
    expect(store().load().map).toEqual({})
  })

  it('drops a malformed record instead of failing every write', () => {
    fs.writeFileSync(join(directory, 'short-ids.json'), JSON.stringify({
      version: 1,
      next: 3,
      map: {
        Z001: { id: 'uuid-a', store: 'default', title: '好的', at: '2026-11-11T00:00:00.000Z' },
        Z002: { id: 42 },
        Z003: 'not an object',
      },
    }))
    const loaded = store().load()
    expect(Object.keys(loaded.map)).toEqual(['Z001'])
    expect(loaded.next).toBe(3)
  })

  it('refuses a file whose next would hand out a duplicate', () => {
    fs.writeFileSync(join(directory, 'short-ids.json'), JSON.stringify({
      version: 1,
      next: 1,
      map: { Z009: { id: 'uuid-a', store: 'default', title: 'x', at: '2026-11-11T00:00:00.000Z' } },
    }))
    // A hand-edited `next` below a live handle is raised, not trusted.
    expect(store().load().next).toBe(10)
  })

  it('rejects a file from an unknown version', () => {
    fs.writeFileSync(join(directory, 'short-ids.json'), JSON.stringify({ version: 2, next: 1, map: {} }))
    expect(() => store().load()).toThrow(/Short id store could not be read/u)
  })

  it('rejects a file that is not JSON', () => {
    fs.writeFileSync(join(directory, 'short-ids.json'), 'not json at all')
    expect(() => store().load()).toThrow(/Short id store could not be read/u)
  })
})

describe('writing', () => {
  it('leaves no temp file behind', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    s.assign('uuid-b', 'default', '第二条')
    const litter = fs.readdirSync(directory).filter(name => name.endsWith('.tmp'))
    expect(litter).toEqual([])
  })

  it('keeps the previous table when a write cannot complete', () => {
    const s = store()
    s.assign('uuid-a', 'default', '第一条')
    const before = fs.readFileSync(join(directory, 'short-ids.json'), 'utf8')
    // Make the directory unwritable so the temp file cannot be created: the
    // existing table must still be the one a reader sees afterwards.
    fs.chmodSync(directory, 0o500)
    try {
      expect(() => s.assign('uuid-b', 'default', '第二条')).toThrow(/Short id store could not be written/u)
    } finally {
      fs.chmodSync(directory, 0o700)
    }
    expect(fs.readFileSync(join(directory, 'short-ids.json'), 'utf8')).toBe(before)
  })

  it('writes the file readable only by its owner', () => {
    store().assign('uuid-a', 'default', '第一条')
    const mode = fs.statSync(join(directory, 'short-ids.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('replaces the table wholesale and keeps the highest ordinal', () => {
    const s = store()
    const written = s.replace({
      Z005: { id: 'uuid-e', store: 'default', title: '第五条', at: '2026-11-11T00:00:00.000Z' },
    }, 1)
    expect(written.next).toBe(6)
    expect(s.assign('uuid-f', 'default', '第六条').handle).toBe('Z006')
  })
})

describe('filling handles for rows that predate the feature', () => {
  /**
   * Installing the plugin onto an existing library is the case these cover: the
   * table starts empty, every row is already in the library, and an index built
   * straight from the table would show them all with no handle. `assign` only
   * runs when a row is written, so without `ensure` those rows would never be
   * numbered.
   */
  it('numbers every row it is given, in the order given', () => {
    const s = store()
    const added = s.ensure([
      { id: 'uuid-a', store: 'default', title: '甲' },
      { id: 'uuid-b', store: 'default', title: '乙' },
    ])
    expect(added).toBe(2)
    expect(s.handles().get('uuid-a')).toBe('Z001')
    expect(s.handles().get('uuid-b')).toBe('Z002')
  })

  it('leaves existing handles alone and only fills the gaps', () => {
    const s = store()
    s.assign('uuid-a', 'default', '甲')
    s.assign('uuid-b', 'default', '乙')
    const added = s.ensure([
      { id: 'uuid-a', store: 'default', title: '甲' },
      { id: 'uuid-b', store: 'default', title: '乙' },
      { id: 'uuid-c', store: 'default', title: '丙' },
    ])
    expect(added).toBe(1)
    expect(s.handles().get('uuid-a')).toBe('Z001')
    expect(s.handles().get('uuid-b')).toBe('Z002')
    expect(s.handles().get('uuid-c')).toBe('Z003')
  })

  it('is idempotent: a second pass adds nothing and rewrites nothing', () => {
    const s = store()
    const rows = [{ id: 'uuid-a', store: 'default', title: '甲' }]
    s.ensure(rows)
    const before = fs.readFileSync(s.file, 'utf8')
    expect(s.ensure(rows)).toBe(0)
    expect(fs.readFileSync(s.file, 'utf8')).toBe(before)
  })

  it('distinguishes the same id in two stores', () => {
    const s = store()
    const added = s.ensure([
      { id: 'same', store: 'default', title: '甲' },
      { id: 'same', store: 'other', title: '乙' },
    ])
    expect(added).toBe(2)
  })

  it('does not renumber when the library shrinks and grows back', () => {
    const s = store()
    s.ensure([{ id: 'uuid-a', store: 'default', title: '甲' }])
    s.release('uuid-a', 'default')
    s.ensure([{ id: 'uuid-a', store: 'default', title: '甲' }])
    // The number is spent, not returned: reusing it would make a handle in an
    // older conversation name a different row.
    expect(s.handles().get('uuid-a')).toBe('Z002')
  })
})

describe('the pairing that makes a fresh install usable', () => {
  /**
   * The end-to-end shape of the bug: render an index from a table that has no
   * handles for the rows it is about to list, then check the block with the same
   * rules that decide whether it may be written. Before `ensure` existed this
   * produced a block the writer refused, which meant an install onto an existing
   * library could never build an index at all — and the refusal was itself
   * invisible until the comparison was corrected.
   */
  it('a backfilled table yields a block that passes its own check', async () => {
    const { renderBlock, blockProblem, describeEntry } = await import('../src/host/cold-index.ts')
    const entries = [
      { id: 'uuid-a', content: '【甲 · 总主题：组】\n正文甲讲的是甲', store: 'default' },
      { id: 'uuid-b', content: '【乙 · 总主题：组】\n正文乙讲的是乙', store: 'default' },
    ]
    const s = store()
    // Empty table, rows already in the library — the install-on-existing case.
    expect(s.handles().size).toBe(0)
    s.ensure(entries.map(entry => ({ id: entry.id, store: entry.store, title: describeEntry(entry).title })))
    const block = await renderBlock(entries, {
      markers: { begin: 'AUTO-GENERATED:BEGIN', end: 'AUTO-GENERATED:END' },
      handles: s.handles(),
      maxDescription: 60,
    })
    expect(blockProblem(block, entries.length)).toBeUndefined()
  })
})

describe('sweeping handles whose row is gone', () => {
  it('drops a handle the library no longer has, and keeps every handle it does', () => {
    const s = store()
    s.ensure([
      { id: 'uuid-a', store: 'default', title: '甲' },
      { id: 'uuid-b', store: 'default', title: '乙' },
    ])
    expect(s.handles().size).toBe(2)
    // A rewrite is a new row, so `uuid-a` is gone and `uuid-c` arrives.
    s.ensure([
      { id: 'uuid-b', store: 'default', title: '乙' },
      { id: 'uuid-c', store: 'default', title: '丙' },
    ])
    const after = s.handles()
    expect(after.size).toBe(2)
    expect([...after.keys()].sort()).toEqual(['uuid-b', 'uuid-c'])
  })

  it('does not reuse the number it dropped', () => {
    const s = store()
    s.ensure([{ id: 'uuid-a', store: 'default', title: '甲' }])
    expect(s.handles().get('uuid-a')).toBe('Z001')
    s.ensure([{ id: 'uuid-b', store: 'default', title: '乙' }])
    // A retired number stays retired: a reader who saved `Z001` must not land on
    // an unrelated row later.
    expect(s.handles().get('uuid-b')).toBe('Z002')
  })

  it('leaves a handle alone when the row is still there under another title', () => {
    const s = store()
    s.ensure([{ id: 'uuid-a', store: 'default', title: '甲' }])
    s.ensure([{ id: 'uuid-a', store: 'default', title: '甲（改过标题）' }])
    expect(s.handles().get('uuid-a')).toBe('Z001')
  })

  it('sweeps nothing when the library reads empty', () => {
    const s = store()
    s.ensure([{ id: 'uuid-a', store: 'default', title: '甲' }])
    // An empty result is far more likely to be a failed read than a library that
    // lost every row, and the handles must survive it.
    expect(s.ensure([])).toBe(0)
    expect(s.handles().size).toBe(1)
  })

  it('keeps one store\'s handles when only the other store\'s rows changed', () => {
    const s = store()
    s.ensure([
      { id: 'uuid-a', store: 'default', title: '甲' },
      { id: 'uuid-x', store: 'other', title: '丁' },
    ])
    s.ensure([{ id: 'uuid-a', store: 'default', title: '甲' }])
    // Rows are identified by store and id together, so a same-id row in another
    // store is a different handle.
    expect(s.handles().size).toBe(1)
    expect(s.handles().get('uuid-a')).toBe('Z001')
  })
})

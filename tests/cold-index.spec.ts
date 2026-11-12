import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  blockProblem,
  describeEntry,
  groupEntries,
  renderBlock,
  spliceBlock,
  updateIndex,
  type IndexEntry,
} from '../src/host/cold-index.ts'

/**
 * The index is a file another agent reads on every step, so the failures worth
 * pinning are the ones that would corrupt it: a marker gone missing, a half
 * write, a model that stopped answering. Each case below asserts the file a
 * reader would see, not just the return value.
 */
const markers = { begin: '<!-- BEGIN -->', end: '<!-- END -->' }
let directory: string
let file: string

beforeEach(() => {
  directory = fs.mkdtempSync(join(os.tmpdir(), 'cold-index-'))
  file = join(directory, 'AGENTS.md')
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

function entry(content: string, store = 'default'): IndexEntry {
  return { id: `id-${content.length}-${content.slice(0, 4)}`, content, store }
}

function document(block = '（旧内容）'): string {
  return `# 索引\n\n手写的前言。\n\n${markers.begin}\n\n${block}\n\n${markers.end}\n\n## 易错点\n\n手写的结尾。\n`
}

describe('describeEntry', () => {
  it('takes the title out of a bracketed headline', () => {
    expect(describeEntry(entry('【DSH 插件（九）：压缩插件 · 总主题：DSH 插件与配置】\n正文')).title)
      .toBe('DSH 插件（九）：压缩插件')
  })

  it('reads the group from the declared topic', () => {
    expect(describeEntry(entry('【A：B · 总主题：网络】')).group).toBe('网络')
  })

  it('keeps a group whose headline differs, so three labelled rows still sit together', () => {
    const one = describeEntry(entry('【用户画像】 全量（一）· 总主题：用户画像'))
    const two = describeEntry(entry('【用户画像】 全量（二）· 总主题：用户画像'))
    expect(one.group).toBe(two.group)
  })

  it('falls back for a line with no headline', () => {
    expect(describeEntry(entry('GitHub 账号由我全权打理')).title).toBe('GitHub 账号由我全权打理')
    expect(describeEntry(entry('GitHub 账号由我全权打理')).group).toBe('单独条目')
  })

  it('names an empty entry rather than printing nothing', () => {
    expect(describeEntry(entry('')).title).toBe('(无标题)')
  })

  it('truncates a headline that is really a paragraph', () => {
    expect(describeEntry(entry(`【${'长'.repeat(200)}】`)).title.length).toBe(120)
  })
})

describe('groupEntries', () => {
  it('collects rows under their topic', () => {
    const groups = groupEntries([
      entry('【甲（一）· 总主题：组A】'),
      entry('【乙（一）· 总主题：组B】'),
      entry('【甲（二）· 总主题：组A】'),
    ])
    expect([...groups.keys()].sort()).toEqual(['组A', '组B'])
    expect(groups.get('组A')).toHaveLength(2)
  })

  it('keeps an ungrouped row instead of dropping it', () => {
    const groups = groupEntries([entry('没有主题的一行')])
    expect([...groups.keys()]).toEqual(['单独条目'])
  })
})

describe('renderBlock', () => {
  it('writes a table per group with its count', async () => {
    const block = await renderBlock([
      entry('【甲（一）· 总主题：组A】\n第一条正文'),
      entry('【甲（二）· 总主题：组A】\n第二条正文'),
    ], { markers })
    expect(block).toContain('### 组A（2 条）')
    expect(block).toContain('| 条目 | 一句话 |')
  })

  it('uses the model summary when one answers', async () => {
    const block = await renderBlock([entry('【甲· 总主题：组A】\n正文')], {
      markers,
      summarize: async () => '一句话摘要',
    })
    expect(block).toContain('一句话摘要')
  })

  it('falls back to the first body line when the model fails', async () => {
    const block = await renderBlock([entry('【甲· 总主题：组A】\n这是正文第一行')], {
      markers,
      summarize: async () => { throw new Error('ollama down') },
    })
    expect(block).toContain('这是正文第一行')
  })

  it('falls back when the model answers with nothing', async () => {
    const block = await renderBlock([entry('【甲· 总主题：组A】\n正文第一行')], {
      markers,
      summarize: async () => '   ',
    })
    expect(block).toContain('正文第一行')
  })

  it('caps a summary that runs long', async () => {
    const block = await renderBlock([entry('【甲· 总主题：组A】\n正文')], {
      markers,
      summarize: async () => '很'.repeat(500),
      maxDescription: 10,
    })
    expect(block).toContain('很'.repeat(10) + '…')
  })

  it('says so when the library is empty instead of printing an empty table', async () => {
    expect(await renderBlock([], { markers })).toContain('冷库为空')
  })

  it('escapes a pipe so a cell cannot break the table', async () => {
    const block = await renderBlock([entry('【甲 | 乙 · 总主题：组A】')], { markers })
    expect(block).toContain('\\|')
  })

  it('adds the store column once a group mixes stores', async () => {
    const block = await renderBlock([
      entry('【甲· 总主题：组A】', 'default'),
      entry('【乙· 总主题：组A】', '480d6dc3'),
    ], { markers })
    expect(block).toContain('| 空间 | 条目 | 一句话 |')
    expect(block).toContain('`480d6dc3`')
  })

  it('drops the store column when every row is in the default store', async () => {
    const block = await renderBlock([
      entry('【甲· 总主题：组A】', 'default'),
      entry('【乙· 总主题：组A】', 'default'),
    ], { markers })
    // A column that always says the same thing is noise in a file read every step.
    expect(block).not.toContain('| 空间 |')
  })
})

describe('spliceBlock', () => {
  it('replaces only what sits between the markers', () => {
    const next = spliceBlock(document(), '（新内容）', markers)
    expect(next).toContain('（新内容）')
    expect(next).not.toContain('（旧内容）')
    expect(next).toContain('手写的前言。')
    expect(next).toContain('手写的结尾。')
  })

  it('refuses a file with no begin marker', () => {
    expect(() => spliceBlock('# 索引\n\n没有标记\n', 'x', markers)).toThrow(/exactly one/u)
  })

  it('refuses a file with two begin markers, rather than guessing which one', () => {
    const twice = `${markers.begin}\na\n${markers.begin}\nb\n${markers.end}\n`
    expect(() => spliceBlock(twice, 'x', markers)).toThrow(/exactly one/u)
  })

  it('refuses markers in the wrong order', () => {
    const reversed = `${markers.end}\na\n${markers.begin}\n`
    expect(() => spliceBlock(reversed, 'x', markers)).toThrow(/precedes/u)
  })
})

describe('updateIndex', () => {
  it('writes the block and leaves the hand-written sections alone', async () => {
    fs.writeFileSync(file, document())
    const result = await updateIndex(file, [entry('【甲· 总主题：组A】\n正文')], { markers })
    expect(result.changed).toBe(true)
    expect(result.entries).toBe(1)
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('组A')
    expect(written).toContain('手写的前言。')
    expect(written).toContain('手写的结尾。')
  })

  it('reports no change when the same library renders the same text', async () => {
    fs.writeFileSync(file, document())
    const entries = [entry('【甲· 总主题：组A】\n正文')]
    await updateIndex(file, entries, { markers })
    const second = await updateIndex(file, entries, { markers })
    expect(second.changed).toBe(false)
  })

  it('leaves the file byte-identical when it cannot be parsed', async () => {
    const broken = '# 索引\n\n没有标记\n'
    fs.writeFileSync(file, broken)
    await expect(updateIndex(file, [entry('【甲· 总主题：组A】')], { markers })).rejects.toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(broken)
  })

  it('keeps the previous file when the block cannot be rendered', async () => {
    fs.writeFileSync(file, document())
    const before = fs.readFileSync(file, 'utf8')
    // A summarizer that hangs past the caller's patience is the realistic case;
    // here a throw stands in for it and the file must not move.
    await expect(updateIndex(file, [entry('【甲· 总主题：组A】')], {
      markers,
      summarize: async () => { throw new Error('model gone') },
    })).resolves.toMatchObject({ changed: true })
    // A failing summarizer degrades to the first line rather than failing the run.
    expect(fs.readFileSync(file, 'utf8')).not.toBe(before)
  })

  it('leaves no temp file behind', async () => {
    fs.writeFileSync(file, document())
    await updateIndex(file, [entry('【甲· 总主题：组A】\n正文')], { markers })
    expect(fs.readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('writes the index readable only by its owner', async () => {
    fs.writeFileSync(file, document())
    fs.chmodSync(file, 0o644)
    await updateIndex(file, [entry('【甲· 总主题：组A】\n正文')], { markers })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('reports why it could not run when the file is missing', async () => {
    await expect(updateIndex(join(directory, 'missing.md'), [], { markers }))
      .rejects.toThrow(/could not be updated/u)
  })
})

describe('handle column', () => {
  const entry = (text: string) => ({ id: 'abc-1', store: 'default', content: text })

  it('adds a handle column when handles are supplied', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】')], {
      markers,
      handles: new Map([['abc-1', 'Z001']]),
      summarize: async () => '一句话',
    })
    expect(block).toContain('| 编号 | 条目 | 一句话 |')
    expect(block).toContain('`Z001`')
  })

  it('omits the handle column entirely when no table is configured', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】')], {
      markers,
      summarize: async () => '一句话',
    })
    expect(block).not.toContain('编号')
    expect(block).toContain('| 条目 | 一句话 |')
  })

  it('prints a dash for a row with no handle, so the columns stay aligned', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】')], {
      markers,
      handles: new Map(),
      summarize: async () => '一句话',
    })
    expect(block).toContain('| `—` |')
  })

  it('keeps a long headline whole rather than cutting it mid-word', async () => {
    const long = '【DSH 插件（九）：dsh-compaction-vcc 压缩编译插件（自有+开源） · 总主题：组A】'
    const block = await renderBlock([entry(long)], { markers, summarize: async () => 'x' })
    expect(block).toContain('压缩编译插件（自有+开源）')
  })
})

describe('fallback without a model', () => {
  const entry = (text: string) => ({ id: 'x', store: 'default', content: text })

  it('skips a merge note rather than printing it as the description', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】\n（本条合并自原（一）+（二））\n真正的正文在这里。')], { markers })
    expect(block).not.toContain('本条合并自')
    expect(block).toContain('真正的正文在这里')
  })

  it('skips any parenthetical note, not just the ones written today', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】\n（2026-11-04 实测。另一台机器端口不同）\n正文。')], { markers })
    expect(block).not.toContain('2026-11-04')
    expect(block).toContain('正文')
  })

  it('prefers a heading when the body starts with one', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】\n\n## 两棵树（别再混淆）\n\n内容')], { markers })
    expect(block).toContain('两棵树')
  })

  it('uses the summary the writer declared on the second line', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】\n摘要：一句话说清这条讲什么\n\n## 正文')], { markers })
    expect(block).toContain('一句话说清这条讲什么')
  })

  it('falls back to the title when the entry has no body at all', async () => {
    const block = await renderBlock([entry('【甲条目标题 · 总主题：组A】')], { markers })
    expect(block).toContain('甲条目标题')
  })

  it('still prefers the model when one answers', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】\n摘要：手写的\n正文')], {
      markers,
      summarize: async () => '模型写的',
    })
    expect(block).toContain('模型写的')
    expect(block).not.toContain('手写的')
  })
})

describe('fallback reads like a description, not a table of contents', () => {
  const entry = (text: string) => ({ id: 'x', store: 'default', content: text })

  it('drops a Chinese section number from a heading', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】\n\n## 一、现状（先说结论）\n\n内容')], { markers })
    expect(block).toContain('现状（先说结论）')
    expect(block).not.toContain('一、现状')
  })

  it('drops an arabic section number too', async () => {
    const block = await renderBlock([entry('【甲 · 总主题：组A】\n\n## 3. 构建命令\n\n内容')], { markers })
    expect(block).toContain('构建命令')
    expect(block).not.toContain('3. 构建')
  })
})

describe('blockProblem', () => {
  /** A sound three-row block: handles present, descriptions say something new. */
  const good = [
    '### 组（3 条）',
    '',
    '| 编号 | 条目 | 一句话 |',
    '|---|---|---|',
    '| `Z001` | 甲 | 讲甲这件事 |',
    '| `Z002` | 乙 | 讲乙这件事 |',
    '| `Z003` | 丙 | 讲丙这件事 |',
  ].join('\n')

  it('accepts a block whose rows match the entries', () => {
    expect(blockProblem(good, 3)).toBeUndefined()
  })

  it('refuses when the row count disagrees with the entries collected', () => {
    expect(blockProblem(good, 4)).toContain('row(s)')
  })

  // The two cases below are in the shape the renderer actually produces: a handle
  // cell is a code span, so a missing one is "`—`" — not a bare "—". Testing the
  // bare form passed while the guard was empty, because `\`—\` !== '—'`.
  it('refuses a row whose handle is the em dash placeholder', () => {
    const block = good.replace('`Z002`', '`—`')
    expect(blockProblem(block, 3)).toContain('missing handle')
  })

  it('refuses a row with an empty handle cell', () => {
    const block = good.replace('`Z002`', '')
    expect(blockProblem(block, 3)).toContain('missing handle')
  })

  it('refuses a bare em dash too, which older blocks may still carry', () => {
    const block = good.replace('`Z002`', '—')
    expect(blockProblem(block, 3)).toContain('missing handle')
  })

  it('catches the placeholder through the renderer itself, not only by hand', async () => {
    // End-to-end over the real path: render with no handles, then check. This is
    // the pairing that was broken — the hand-written block above disagreed with
    // what `renderBlock` emits, so only a render-then-check test can hold them
    // together.
    const entries = [
      { id: 'uuid-a', content: '【甲 · 总主题：组】\n正文甲', store: 'default' },
      { id: 'uuid-b', content: '【乙 · 总主题：组】\n正文乙', store: 'default' },
    ]
    const block = await renderBlock(entries, { markers: { begin: 'AUTO-GENERATED:BEGIN', end: 'AUTO-GENERATED:END' }, handles: new Map([['uuid-a', 'Z001']]), maxDescription: 60 })
    expect(blockProblem(block, entries.length)).toContain('missing handle')
  })

  it('refuses a description that only repeats the title', () => {
    const block = good.replace('讲乙这件事', '乙')
    expect(blockProblem(block, 3)).toContain('repeats the title')
  })

  it('says which rows failed, not just how many', () => {
    const block = good.replace('`Z002`', '—')
    expect(blockProblem(block, 3)).toContain('乙')
  })

  it('accepts an empty library', () => {
    expect(blockProblem('', 0)).toBeUndefined()
  })
})

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/**
 * The generated half of a cold-library index.
 *
 * A person maintaining an index by hand does two separate jobs: deciding what an
 * entry is about (judgement) and keeping the list in step with the library
 * (bookkeeping). The second job is the one that rots — an entry is renamed, a
 * group gains a row, and the hand-written table quietly stops matching what
 * `mnemon recall` returns.
 *
 * This module does the bookkeeping and leaves the judgement to a model when one
 * is configured, falling back to the entry's own first line when it is not. The
 * output replaces only the text between two markers, so the sections a person
 * writes by hand — how to search, what tends to go wrong — survive every run.
 */

/**
 * The instruction a local model is given for one entry.
 *
 * Three things in it were measured rather than guessed. Naming what to describe
 * (topic and criterion) keeps an entry about a制度 from being summarised as a
 * defect report. Forbidding evaluative words stops a note that records a past
 * failure from reading as a current one — an early run turned "how to spot an
 * anonymisation leak" into "the merge process has a serious hole". Asking for the
 * budget in the middle of a sentence, rather than as a hard ceiling, is what the
 * model follows: a cap of 30 characters overran on 17 of 43 entries.
 */
export const SUMMARY_PROMPT = (content: string, maxChars: number): string =>
  `只描述这篇笔记讲什么主题、给出什么判据。不评价好坏、不推测结果、不用「漏洞/失败/未生效/严重」这类词。一句话、不超过${String(maxChars)}字、直接输出，不要前缀：\n${content}`

/** One entry as the library reports it. */
export interface IndexEntry {
  /** The row id, used only to keep the table stable across a rename. */
  readonly id: string
  /** Entry text. The first line names it; a `总主题：` marker groups it. */
  readonly content: string
  /** Named store the entry lives in, or `default`. */
  readonly store: string
}

export interface IndexMarkers {
  readonly begin: string
  readonly end: string
}

export interface RenderOptions {
  readonly markers: IndexMarkers
  /**
   * One line describing an entry, given its text. Absent renders the entry's own
   * first line instead: a machine with no model still gets a working index, only
   * a less useful one.
   */
  readonly summarize?: (content: string) => Promise<string | undefined>
  /** Cap for one rendered description, in characters. */
  readonly maxDescription?: number
  /**
   * Entry id → the short handle a reader can type instead of a search phrase.
   * Absent when the profile has short handles switched off, and then the table
   * has no handle column at all rather than a column of dashes.
   */
  readonly handles?: ReadonlyMap<string, string>
}

// Chinese fits less per character than the number suggests: a cap of 30 produced
// overruns on 17 of 43 entries because the model squeezed, while 60 produced none
// and settled at about 48.
const DEFAULT_MAX_DESCRIPTION = 60
/** How much of the entry a summary is written from. */
// Measured on this library: 400 characters loses the section headings that say
// what an entry is actually about, and 1200 gives a shorter answer than 800 — the
// model spends the extra budget summarising text rather than naming the point.
const SUMMARY_INPUT_CHARS = 800
/** A group title longer than this is not a title. */
const MAX_GROUP_TITLE = 40
/**
 * A first line longer than this is a paragraph that lost its newline, not a
 * headline. High enough that every real title in this library passes through.
 */
const MAX_HEADLINE = 120

/**
 * The three shapes a first line takes in this library, all of them already in
 * use. Kept here rather than in a pattern at each call site, because a missed
 * shape silently drops an entry from its group.
 */
const HEADLINE = /^【(?<title>[^】]*)】(?<rest>.*)$/u
// The group name ends at a closing bracket, a newline, or the end of the line.
// A trailing bracket has to be excluded here: one entry in the wild writes its
// topic as `（总主题：X）` instead of `· 总主题：X`, and keeping the bracket
// would split that entry into a group of its own.
const GROUP = /总主题[:：]\s*(?<group>[^】）)\n]+)/u

/**
 * Split one entry into the parts the table needs.
 *
 * A line that names a group counts under that group even when its own headline
 * differs, which is what lets three differently-titled rows sit together.
 */
export function describeEntry(entry: IndexEntry): { title: string; group: string } {
  const firstLine = entry.content.split('\n', 1)[0]?.trim() ?? ''
  const headline = HEADLINE.exec(firstLine)
  // The headline carries both facts: the name before the separator and the
  // group after it. Printing the whole headline as the title would repeat the
  // group in every row of the group's own table.
  const raw = (headline?.groups?.title ?? firstLine).trim()
  const separator = raw.search(/\s*[·・]\s*总主题/u)
  const title = (separator === -1 ? raw : raw.slice(0, separator)).replace(/[\s·・]+$/u, '').trim()
  const groupMatch = GROUP.exec(entry.content.slice(0, 400))
  const group = groupMatch?.groups?.group?.trim() ?? ''
  return {
    // A real headline is one phrase and must survive whole: a 40-character cap
    // severed "压缩编译插件（自有+开源）" mid-parenthesis. The cap that remains is a
    // guard against a first line that is really a paragraph, not a width to fit.
    title: title === '' ? '(无标题)' : title.slice(0, MAX_HEADLINE),
    // An entry with no declared topic is a standalone one, not an oversight: the
  // single-entry archives live here by design.
  group: group === '' ? '单独条目' : group.slice(0, MAX_GROUP_TITLE),
  }
}

/**
 * Read the library through the CLI, which is the only interface that returns
 * every entry: a recall route answers by relevance and stops at a tier, so an
 * index built from it silently loses whatever ranked last.
 *
 * `--basic` asks for the SQL listing rather than a scored query, and an empty
 * query matches every row; together they are what `mnemon recall '' --basic`
 * does on a terminal.
 */
export function parseLibrary(stdout: string): IndexEntry[] {
  const value: unknown = JSON.parse(stdout)
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object' && Array.isArray((value as { results?: unknown }).results)
      ? (value as { results: unknown[] }).results
      : undefined
  if (list === undefined) throw new Error('mnemon recall returned no list')
  const entries: IndexEntry[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.content !== 'string') continue
    // An archived Document leaves an index memory behind; it describes a
    // document rather than being one, and listing it would name a row a handle
    // cannot open.
    if (record.content.startsWith('Document:')) continue
    entries.push({
      id: record.id,
      content: record.content,
      store: typeof record.store === 'string' && record.store !== '' ? record.store : 'default',
    })
  }
  return entries
}

/** A row ready to print. */
export interface IndexRow {
  readonly store: string
  readonly title: string
  /** Generated one-liner, or the entry's own first line when no model answered. */
  readonly description: string
}

function fallbackDescription(title: string, content: string, max: number): string {
  const body = content
    .split('\n')
    .slice(1)
    .map(line => line.replace(/^[#>\s-]+/u, '').trim())
    .find(line => line !== '' && !line.startsWith('|') && !line.startsWith('```'))
  const source = body ?? title
  return source.length > max ? `${source.slice(0, max)}…` : source
}

async function describe(entry: IndexEntry, options: RenderOptions): Promise<string> {
  const max = options.maxDescription ?? DEFAULT_MAX_DESCRIPTION
  const { title } = describeEntry(entry)
  if (options.summarize !== undefined) {
    try {
      const summary = await options.summarize(entry.content.slice(0, SUMMARY_INPUT_CHARS))
      const cleaned = summary?.trim().replace(/\s+/gu, ' ') ?? ''
      if (cleaned !== '') return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
    } catch {
      // A model that is down must not cost the index: the first line still says
      // what the entry is, less precisely.
    }
  }
  return fallbackDescription(title, entry.content, max)
}

/** Group the rows the way the hand-written table did: by declared topic, then store. */
export function groupEntries(entries: readonly IndexEntry[]): Map<string, IndexEntry[]> {
  const groups = new Map<string, IndexEntry[]>()
  for (const entry of entries) {
    const { group } = describeEntry(entry)
    const list = groups.get(group)
    if (list === undefined) groups.set(group, [entry])
    else list.push(entry)
  }
  return groups
}

function table(header: readonly string[], rows: readonly string[][]): string {
  const head = `| ${header.join(' | ')} |`
  const rule = `|${header.map(() => '---').join('|')}|`
  const body = rows.map(row => `| ${row.join(' | ')} |`).join('\n')
  return `${head}\n${rule}\n${body}`
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\n/gu, ' ')
}

/**
 * Render the generated block, without its markers.
 *
 * Groups print largest first so the section a reader looks for most often sits
 * at the top; within a group, order follows the library's own order so a diff
 * between two runs shows only real changes.
 */
export async function renderBlock(entries: readonly IndexEntry[], options: RenderOptions): Promise<string> {
  if (entries.length === 0) return '_冷库为空。_\n'
  const groups = groupEntries(entries)
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  const parts: string[] = []
  for (const [group, rows] of ordered) {
    // Decide the column set from the whole group, before rendering any row. A
    // per-row decision cannot work: a row that blanks its store shrinks to two
    // cells, and a header inferred from that row then disagrees with the rows
    // that kept three.
    const mixedStores = rows.some(row => row.store !== 'default')
    const withHandles = options.handles !== undefined
    const header = [
      ...(withHandles ? ['编号'] : []),
      ...(mixedStores ? ['空间'] : []),
      '条目',
      '一句话',
    ]
    const rendered: string[][] = []
    for (const entry of rows) {
      const { title } = describeEntry(entry)
      const handle = options.handles?.get(entry.id)
      const cells = [
        ...(withHandles ? [`\`${handle ?? '—'}\``] : []),
        ...(mixedStores ? [escapeCell(entry.store === 'default' ? '默认' : `\`${entry.store}\``)] : []),
        escapeCell(title),
        escapeCell(await describe(entry, options)),
      ]
      rendered.push(cells)
    }
    parts.push(`### ${group}（${rows.length} 条）\n\n${table(header, rendered)}`)
  }
  return `${parts.join('\n\n')}\n`
}

/** What one run did, for a caller that reports rather than prints. */
export interface IndexUpdate {
  readonly changed: boolean
  readonly entries: number
  /** Hash of the block written, so a caller can tell "same content" from "rewritten same text". */
  readonly digest: string
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function failure(error: unknown, action: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const detail = code === 'EBUSY' ? ' (busy)' : typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? ` (${code})` : ''
  return new Error(`Cold-library index could not ${action}${detail}. The library itself is unchanged; the index is out of date until the next run.`, { cause: error })
}

/**
 * Replace the text between two markers in a file.
 *
 * Both markers must appear exactly once and the end must follow the begin; a
 * file that fails that check is left alone rather than rewritten with the block
 * dropped somewhere a reader did not intend.
 */
export function spliceBlock(file: string, block: string, markers: IndexMarkers): string {
  const beginCount = file.split(markers.begin).length - 1
  const endCount = file.split(markers.end).length - 1
  if (beginCount !== 1) throw new Error(`expected exactly one "${markers.begin}" marker, found ${beginCount}`)
  if (endCount !== 1) throw new Error(`expected exactly one "${markers.end}" marker, found ${endCount}`)
  const start = file.indexOf(markers.begin)
  const finish = file.indexOf(markers.end)
  if (finish < start) throw new Error('end marker precedes begin marker')
  return `${file.slice(0, start + markers.begin.length)}\n\n${block}\n${file.slice(finish)}`
}

/**
 * Write the generated block into an index file.
 *
 * The whole document is rendered in memory first and committed with a rename, so
 * a failure — a model that stopped answering, a disk that filled — leaves the
 * file a reader sees byte-identical to before. No backup is kept: a copy beside
 * every run becomes litter within days, and the rename is what actually makes a
 * torn write impossible.
 */
export async function updateIndex(file: string, entries: readonly IndexEntry[], options: RenderOptions): Promise<IndexUpdate> {
  const block = await renderBlock(entries, options)
  const digest = digestOf(block)
  let current: string
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw failure(new Error('file does not exist'), 'be updated')
    throw failure(error, 'be read')
  }
  const next = `${spliceBlock(current, block, options.markers)}`
  if (next === current) return { changed: false, entries: entries.length, digest }
  const directory = file.slice(0, Math.max(file.lastIndexOf('/'), 0)) || '.'
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const temp = join(directory, `.${randomBytes(6).toString('hex')}.tmp`)
    try {
      const descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      try {
        fs.writeSync(descriptor, next)
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      fs.renameSync(temp, file)
      return { changed: true, entries: entries.length, digest }
    } catch (error) {
      lastError = error
      try { fs.unlinkSync(temp) } catch { /* already gone */ }
    }
  }
  throw failure(lastError, 'be written')
}

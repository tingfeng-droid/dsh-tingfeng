import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Short ids for cold-library entries.
 *
 * A cold-library entry is addressed by a 36-character UUID that changes every
 * time the entry is rewritten (the CLI has no update: a rewrite is a new row,
 * and the old one is soft-deleted). Typing that UUID to retrieve one entry is
 * not a workflow, and searching for a topic returns a ranked list rather than
 * the one entry meant.
 *
 * This store keeps a small, human-sized handle per entry: `Z001`, `Z002`, ...
 * The handle is what a person reads and types; the UUID stays an implementation
 * detail. A rewrite allocates a NEW handle and drops the old one — the handle is
 * a pointer to the current row, not a stable identity. That is the deliberate
 * trade: stable identity would need a matching rule, and a matching rule guesses
 * wrong on the entries a person cares most about.
 *
 * The file is machine-local state, deliberately outside Packs and Git sync: two
 * machines may hold different handles for the same entry, and that is fine.
 */

export interface ShortIdRecord {
  /** The entry's UUID in its store. */
  readonly id: string
  /** Named memory store the entry lives in, or `default` when unnamed. */
  readonly store: string
  /** First line of the entry, kept so a stale handle is recognisable. */
  readonly title: string
  /** When this handle was last pointed at a row, ISO 8601. */
  readonly at: string
}

export interface ShortIdFile {
  readonly version: 1
  /** Next ordinal to hand out. Never decreases, so handles are not reused. */
  readonly next: number
  /** Handle (`Z001`) to record. */
  readonly map: Readonly<Record<string, ShortIdRecord>>
}

export interface ShortIdOptions {
  /** Handle prefix, e.g. `Z`. */
  readonly prefix: string
  /** Zero-padded width of the ordinal, e.g. 3 gives `Z001`. */
  readonly digits: number
  /** Directory holding the state file. */
  readonly directory: string
}

const FILE_NAME = 'short-ids.json'
const MAX_FILE_BYTES = 4_194_304
const MAX_PREFIX_LENGTH = 8
const MAX_DIGITS = 9
const MAX_ENTRIES = 100_000
const TEMP_ATTEMPTS = 5

function empty(): ShortIdFile {
  return { version: 1, next: 1, map: {} }
}

function failure(error: unknown, action: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const detail = code === 'EBUSY' ? ' (busy)' : typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? ` (${code})` : ''
  return new Error(`Short id store could not ${action}${detail}. Memory writes still work; only the handle table is stale. Check ${FILE_NAME} under the storage root and retry.`, { cause: error })
}

function isValidPrefix(value: string): boolean {
  // Letters only: a prefix that could be a digit would make `123` ambiguous
  // between a handle and an entry that happens to start with a number.
  return value.length > 0 && value.length <= MAX_PREFIX_LENGTH && /^[A-Za-z]+$/u.test(value)
}

/**
 * The handle grammar one file uses. Exposed so callers can tell "this query is
 * a handle" from "this query is a topic" without duplicating the rule.
 */
/**
 * The shape of one handle.
 *
 * Case-insensitive: `z016` and `Z016` name the same entry, because the person
 * typing it does not think about which shift key the table happens to use. The
 * table still stores one spelling, and `normalizeShortId` maps input onto it.
 */
export function shortIdPattern(options: Pick<ShortIdOptions, 'prefix' | 'digits'>): RegExp {
  const prefix = options.prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^${prefix}\\d{${options.digits}}$`, 'iu')
}

/** The handle as the table spells it: same prefix casing, same digits. */
export function normalizeShortId(options: Pick<ShortIdOptions, 'prefix' | 'digits'>, input: string): string {
  return formatShortId(options, Number(input.trim().slice(options.prefix.length)))
}

/** Render one ordinal as a handle. */
export function formatShortId(options: Pick<ShortIdOptions, 'prefix' | 'digits'>, ordinal: number): string {
  return `${options.prefix}${String(ordinal).padStart(options.digits, '0')}`
}

/**
 * Parse and validate a file read from disk.
 *
 * A malformed entry is dropped rather than thrown: the table is a convenience,
 * and refusing to load it would make every memory write fail for a reason the
 * user cannot act on. `next` is recomputed against the surviving handles so a
 * hand-edited file cannot hand out a duplicate.
 */
function parse(raw: string): ShortIdFile {
  const value: unknown = JSON.parse(raw)
  if (value === null || typeof value !== 'object') throw new Error('not an object')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('unsupported version')
  const next = record.next
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 1) throw new Error('invalid next')
  const map = record.map
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new Error('invalid map')
  const kept: Record<string, ShortIdRecord> = {}
  let highest = 0
  let count = 0
  for (const [key, entry] of Object.entries(map as Record<string, unknown>)) {
    if (count >= MAX_ENTRIES) break
    if (entry === null || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || e.id === '') continue
    if (typeof e.store !== 'string') continue
    if (typeof e.title !== 'string') continue
    if (typeof e.at !== 'string') continue
    kept[key] = { id: e.id, store: e.store, title: e.title, at: e.at }
    count += 1
    const ordinal = Number(key.replace(/\D/gu, ''))
    if (Number.isSafeInteger(ordinal) && ordinal > highest) highest = ordinal
  }
  // `next` below the highest live handle would hand out a duplicate on the next
  // allocation, so the file's own value is a floor rather than the answer.
  return { version: 1, next: Math.max(next, highest + 1), map: kept }
}

/**
 * The handle table for one machine.
 *
 * Every write lands through a temp file in the same directory and a rename, so a
 * crash or a full disk leaves the previous table intact instead of a half-written
 * one. No backup file is kept: a copy beside every touch becomes litter within
 * days, and the rename is what actually makes a torn write impossible.
 */
export class ShortIdStore {
  private readonly path: string
  private readonly options: Pick<ShortIdOptions, 'prefix' | 'digits'>

  constructor(options: ShortIdOptions) {
    if (!isValidPrefix(options.prefix)) throw new Error('short id prefix must be 1-8 ASCII letters')
    if (!Number.isSafeInteger(options.digits) || options.digits < 1 || options.digits > MAX_DIGITS) throw new Error(`short id digits must be 1-${MAX_DIGITS}`)
    this.options = { prefix: options.prefix, digits: options.digits }
    this.path = join(resolve(options.directory), FILE_NAME)
  }

  /** The file this store reads and writes, for diagnostics. */
  get file(): string {
    return this.path
  }

  load(): ShortIdFile {
    let descriptor: number | undefined
    try {
      try {
        descriptor = fs.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
        throw failure(error, 'be read')
      }
      const info = fs.fstatSync(descriptor)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('invalid file')
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null)
        if (read === 0) break
        length += read
      }
      if (length > MAX_FILE_BYTES) throw new Error('oversized')
      const text = buffer.subarray(0, length).toString('utf8')
      if (text.trim() === '') return empty()
      return parse(text)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Short id store')) throw error
      // A damaged table is not worth failing a memory write over: the entries
      // are still in the cold library, only their handles are lost.
      throw failure(error, 'be read')
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
    }
  }

  /**
   * Point a fresh handle at one row.
   *
   * The caller passes the row it just wrote. Any handle already pointing at that
   * UUID is dropped first, so a rewrite that re-reports the same row does not
   * leave two handles for it.
   */
  assign(id: string, store: string, title: string): { readonly handle: string; readonly file: ShortIdFile } {
    const current = this.load()
    const map: Record<string, ShortIdRecord> = {}
    for (const [key, entry] of Object.entries(current.map)) {
      if (entry.id === id && entry.store === store) continue
      map[key] = entry
    }
    const handle = formatShortId(this.options, current.next)
    const at = new Date().toISOString()
    map[handle] = { id, store, title, at }
    const file: ShortIdFile = { version: 1, next: current.next + 1, map }
    this.write(file)
    return { handle, file }
  }

  /**
   * Give every listed row a handle if it has none, in one read and one write.
   *
   * A profile that installs this plugin onto a library it already has starts with
   * rows that were written before handles existed. Only `assign` was available,
   * and it is called when a row is written — so those rows would never get a
   * handle, and an index built from the table would show them all as blanks
   * forever. Installing the feature is exactly the moment to fill them in.
   *
   * Idempotent: rows that already have a handle keep it, so running this on every
   * index build costs nothing after the first pass and never renumbers. Ordering
   * follows the caller's list so the numbers match the order a reader sees.
   */
  ensure(rows: readonly { readonly id: string; readonly store: string; readonly title: string }[]): number {
    const current = this.load()
    const taken = new Set(Object.values(current.map).map(entry => `${entry.store}\u0000${entry.id}`))
    const live = new Set(rows.map(row => `${row.store}\u0000${row.id}`))
    const map: Record<string, ShortIdRecord> = { ...current.map }
    const at = new Date().toISOString()
    let next = current.next
    let added = 0
    // `rows` is the whole library, so a handle whose row is not in it points at
    // nothing: the CLI has no update, so every rewrite is a new row and the old
    // one is soft-deleted. Without this sweep those handles accumulate — one
    // library here reached 69 rows for 68 entries, 24 of them dead — and each one
    // is a handle the reader can type that answers nothing.
    let dropped = 0
    // Refuse to sweep against an empty library: a failed read or a Provider that
    // answered nothing would otherwise look exactly like "every row is gone" and
    // wipe the whole table. The index an empty library renders is one line, so
    // nothing is lost by leaving the handles for the next real build.
    if (rows.length > 0) {
      for (const [handle, entry] of Object.entries(map)) {
        if (live.has(`${entry.store}\u0000${entry.id}`)) continue
        delete map[handle]
        dropped += 1
      }
    }
    for (const row of rows) {
      const key = `${row.store}\u0000${row.id}`
      if (taken.has(key)) continue
      const handle = formatShortId(this.options, next)
      map[handle] = { id: row.id, store: row.store, title: row.title, at }
      taken.add(key)
      next += 1
      added += 1
    }
    if (added > 0 || dropped > 0) this.write({ version: 1, next, map })
    return added
  }

  /** Drop the handle pointing at one row, if any. */
  release(id: string, store: string): ShortIdFile {
    const current = this.load()
    const map: Record<string, ShortIdRecord> = {}
    let changed = false
    for (const [key, entry] of Object.entries(current.map)) {
      if (entry.id === id && entry.store === store) { changed = true; continue }
      map[key] = entry
    }
    const file: ShortIdFile = { version: 1, next: current.next, map }
    if (changed) this.write(file)
    return file
  }

  /**
   * Every live handle, keyed by the row it names.
   *
   * One row can carry several handles when a rewrite happened to keep the old
   * one alive; the newest wins, so the index prints the handle a reader is most
   * likely to have been told about.
   */
  handles(): ReadonlyMap<string, string> {
    const out = new Map<string, string>()
    for (const [handle, entry] of Object.entries(this.load().map).sort((a, b) => a[0].localeCompare(b[0]))) {
      out.set(entry.id, handle)
    }
    return out
  }

  /** Look one handle up, or `undefined` when it names nothing live. */
  resolve(handle: string): ShortIdRecord | undefined {
    const map = this.load().map
    return map[handle] ?? map[normalizeShortId(this.options, handle)]
  }

  /** True when the query is shaped like a handle for this table. */
  isHandle(query: string): boolean {
    return shortIdPattern(this.options).test(query.trim())
  }

  /**
   * Replace the table wholesale, keeping the highest ordinal ever handed out.
   *
   * Used when a caller has already reconciled the table against the library, so
   * a handle that survived keeps its ordinal and a new row gets the next one.
   */
  replace(map: Readonly<Record<string, ShortIdRecord>>, next: number): ShortIdFile {
    const file: ShortIdFile = { version: 1, next: Math.max(next, highOrdinal(Object.keys(map)) + 1), map }
    this.write(file)
    return file
  }

  private write(file: ShortIdFile): void {
    const text = `${JSON.stringify(file, undefined, 2)}\n`
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('short id table exceeds its size limit')
    const directory = dirname(this.path)
    fs.mkdirSync(directory, { recursive: true })
    let lastError: unknown
    for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
      const temp = join(directory, `.${FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`)
      try {
        const descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
        try {
          fs.writeSync(descriptor, text)
          fs.fsyncSync(descriptor)
        } finally {
          fs.closeSync(descriptor)
        }
        // Rename is the commit point: a reader sees either the old table or the
        // new one, never a partial write.
        fs.renameSync(temp, this.path)
        return
      } catch (error) {
        lastError = error
        try { fs.unlinkSync(temp) } catch { /* already gone */ }
      }
    }
    throw failure(lastError, 'be written')
  }
}

function highOrdinal(handles: readonly string[]): number {
  let highest = 0
  for (const key of handles) {
    const ordinal = Number(key.replace(/\D/gu, ''))
    if (Number.isSafeInteger(ordinal) && ordinal > highest) highest = ordinal
  }
  return highest
}

import { execFileSync } from 'node:child_process'
import type { ShortIdStore } from './short-ids.ts'

/** One insight, in the shape `mnemon_recall` reports its results. */
export interface HandleHit {
  readonly id: string
  readonly content: string
  readonly score: number
}

export interface HandleLookupOptions {
  /** The CLI executable the rest of the plugin uses. */
  readonly command: string
  readonly dataDir: string
  readonly timeoutMs: number
  /** Environment additions, chiefly the embedding model, matching other CLI calls. */
  readonly env?: NodeJS.ProcessEnv
  /**
   * How to run the CLI. Injectable so the two-step lookup is testable without a
   * database on disk; production passes nothing and gets `execFileSync`.
   */
  readonly run?: (command: string, argv: readonly string[], options: { encoding: 'utf8'; timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number; windowsHide: boolean }) => string
}

/**
 * Resolve one short handle to the single entry it names.
 *
 * `mnemon` itself knows nothing about handles, so the lookup is two steps: the
 * table turns `Z015` into a UUID, and `mnemon show` turns the UUID into the entry.
 * A store route cannot do this — `memory-spaces` has no read-by-id route, and
 * adding one would mean a new contract for a lookup only this plugin performs.
 *
 * Returns undefined when the handle names nothing, which is the ordinary case for
 * a number whose entry was deleted; the caller then falls back to a normal query
 * rather than answering "no results", because a phrase that merely looks like a
 * handle may still be a real search.
 */
export function lookupHandle(handle: string, store: ShortIdStore, options: HandleLookupOptions): HandleHit | undefined {
  const record = store.resolve(handle)
  if (record === undefined) return undefined

  const argv = ['--data-dir', options.dataDir]
  // A 480-space entry is only reachable with its own store, and `show` reports
  // `no rows` rather than an error when it is missing.
  if (record.store !== '' && record.store !== 'default') argv.push('--store', record.store)
  argv.push('show', record.id)

  let stdout: string
  try {
    const settings = {
      encoding: 'utf8' as const,
      timeout: options.timeoutMs,
      env: { ...process.env, ...options.env },
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }
    stdout = options.run === undefined
      ? execFileSync(options.command, argv, settings)
      : options.run(options.command, argv, settings)
  } catch {
    // The entry is gone or the CLI failed: no hit, and no error either. A handle
    // lookup must never be the reason a recall fails.
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const content = typeof value.content === 'string' ? value.content : undefined
  const id = typeof value.id === 'string' ? value.id : record.id
  if (content === undefined) return undefined
  // Score 1 is the same convention `search` uses for an exact word match, so a
  // caller that ranks or filters on score treats a handle hit as the best possible.
  return { id, content, score: 1 }
}

/**
 * Whether a query is shaped like this table's handles.
 *
 * Delegates to the store so the pattern has one definition. Returns false when
 * the table is switched off, which keeps `Z015` searchable as text on profiles
 * that never turned handles on.
 */
export function isHandleQuery(query: string, store: ShortIdStore | undefined): boolean {
  if (store === undefined) return false
  const trimmed = query.trim()
  if (trimmed === '') return false
  return store.isHandle(trimmed)
}

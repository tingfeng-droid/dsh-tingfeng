import type { IndexEntry, IndexMarkers, IndexUpdate } from './cold-index.ts'

/**
 * When a generated index is written.
 *
 * A batch of edits is the normal case — a run that merges six entries writes six
 * times — so a write per edit would rewrite one file six times and show a reader
 * five intermediate states. The schedule is therefore not a fixed interval but a
 * quiet period: each change pushes the write out, and the file is written once
 * the library has stopped moving.
 *
 * A caller that has to read the index right now does not wait for that: `flush`
 * writes immediately and cancels the timer.
 */

export interface IndexSyncOptions {
  /** Quiet period after the last change, in milliseconds. Zero writes on the next tick. */
  readonly debounceMs: number
  /** Build the entries to render. Read at write time, so the write sees the latest library. */
  readonly collect: () => Promise<readonly IndexEntry[]>
  /** Write the block. Supplied by the caller that owns the file. */
  readonly write: (entries: readonly IndexEntry[]) => Promise<IndexUpdate>
  /** Where the block goes, for diagnostics. */
  readonly markers: IndexMarkers
  /** Cap for one description, in characters. */
  readonly maxChars: number
  /** Writes one description from an entry. Absent keeps the first line. */
  readonly summarize?: (content: string) => Promise<string | undefined>
  /** Called with a failure instead of throwing into whatever triggered the change. */
  readonly onError?: (error: unknown) => void
}

/** What one scheduled run did, for a caller that reports rather than waits. */
export interface IndexSyncRun {
  readonly entries: number
  readonly changed: boolean
  readonly digest: string
}

/**
 * One machine's index schedule.
 *
 * `notify` is the only thing a writer has to call: it arms the timer and returns.
 * The run itself happens later, so a memory write never waits for a model.
 */
export class ColdIndexSync {
  private timer: NodeJS.Timeout | undefined
  private running: Promise<IndexSyncRun | undefined> | undefined
  private pending = false
  private disposed = false
  private readonly options: IndexSyncOptions

  constructor(options: IndexSyncOptions) {
    this.options = options
  }

  /** True while a change is waiting for its quiet period to end. */
  get dirty(): boolean {
    return this.pending
  }

  /** True while a write is in flight. */
  get busy(): boolean {
    return this.running !== undefined
  }

  /**
   * Record that the library changed.
   *
   * Calling this repeatedly inside the quiet period produces one write. A change
   * that arrives while a run is in flight sets the flag again, so the next run
   * sees it rather than being lost between the read and the write.
   */
  notify(): void {
    if (this.disposed) return
    this.pending = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    const delay = this.options.debounceMs
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, delay)
    // A pending index is not a reason to keep the process alive: the next write
    // arms it again, and `flush` exists for a caller that cannot wait.
    this.timer.unref?.()
  }

  /**
   * Write now, cancelling the quiet period.
   *
   * Used when a caller is about to read the index: waiting out the quiet period
   * would show stale handles to the very reader that asked.
   */
  async flush(): Promise<IndexSyncRun | undefined> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    return this.run()
  }

  /** Stop scheduling. A run already in flight is awaited by `flush` only. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pending = false
  }

  private run(): Promise<IndexSyncRun | undefined> {
    if (this.disposed) return Promise.resolve(undefined)
    // One run at a time: two overlapping renders would race on the file and the
    // later rename would win with a block built from an older library.
    if (this.running !== undefined) {
      this.pending = true
      return this.running
    }
    if (!this.pending) return Promise.resolve(undefined)
    this.pending = false
    const operation = this.execute()
    this.running = operation
    void operation.finally(() => {
      this.running = undefined
      // A change that landed mid-run re-arms, so the next write sees it.
      if (this.pending && !this.disposed) this.notify()
    }).catch(() => undefined)
    return operation
  }

  private async execute(): Promise<IndexSyncRun | undefined> {
    try {
      const entries = await this.options.collect()
      const update = await this.options.write(entries)
      return { entries: update.entries, changed: update.changed, digest: update.digest }
    } catch (error) {
      // The library is unaffected: the next change re-arms and the next read
      // reports its own state. Surfacing here would fail a memory write for a
      // reason that has nothing to do with it.
      this.options.onError?.(error)
      return undefined
    }
  }
}

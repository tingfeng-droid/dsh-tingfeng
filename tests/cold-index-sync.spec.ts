import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ColdIndexSync } from '../src/host/cold-index-sync.ts'
import type { IndexUpdate } from '../src/host/cold-index.ts'

/**
 * The schedule exists so a batch of edits produces one write, and so a reader
 * that asks now does not get yesterday's handles. Both are timing properties, so
 * these tests drive the clock rather than sleeping: a real 300-second quiet
 * period in a test suite would be a reason not to run it.
 */
const entries = [{ id: 'uuid-a', content: '【甲· 总主题：组A】', store: 'default' }]

function update(changed = true): IndexUpdate {
  return { changed, entries: 1, digest: 'abc123' }
}

function sync(options: Partial<{
  debounceMs: number
  write: (entries: readonly { id: string; content: string; store: string }[]) => Promise<IndexUpdate>
  collect: () => Promise<typeof entries>
  onError: (error: unknown) => void
}> = {}) {
  return new ColdIndexSync({
    debounceMs: options.debounceMs ?? 300_000,
    maxChars: 40,
    markers: { begin: 'B', end: 'E' },
    collect: options.collect ?? (async () => entries),
    write: options.write ?? (async () => update()),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('quiet period', () => {
  it('writes once for a batch of changes', async () => {
    const write = vi.fn(async () => update())
    const s = sync({ write, debounceMs: 1_000 })
    s.notify()
    s.notify()
    s.notify()
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('pushes the write out when a change arrives inside the quiet period', async () => {
    const write = vi.fn(async () => update())
    const s = sync({ write, debounceMs: 1_000 })
    s.notify()
    await vi.advanceTimersByTimeAsync(800)
    s.notify()
    await vi.advanceTimersByTimeAsync(800)
    // 1,600ms after the first change and still nothing: the second one restarted it.
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when nothing changed', async () => {
    const write = vi.fn(async () => update())
    const s = sync({ write })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(write).not.toHaveBeenCalled()
  })

  it('writes on the next tick when the quiet period is zero', async () => {
    const write = vi.fn(async () => update())
    const s = sync({ write, debounceMs: 0 })
    s.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('flush', () => {
  it('writes immediately instead of waiting out the quiet period', async () => {
    const write = vi.fn(async () => update())
    const s = sync({ write })
    s.notify()
    const result = await s.flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(result?.changed).toBe(true)
    // The cancelled timer must not fire a second write later.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('reports nothing when there was nothing to write', async () => {
    const s = sync()
    expect(await s.flush()).toBeUndefined()
  })

  it('reports the run a caller can show', async () => {
    const s = sync({ write: async () => ({ changed: true, entries: 7, digest: 'deadbeef' }) })
    s.notify()
    expect(await s.flush()).toEqual({ entries: 7, changed: true, digest: 'deadbeef' })
  })
})

describe('one run at a time', () => {
  it('re-arms when a change lands while a run is in flight', async () => {
    let release: (() => void) | undefined
    const write = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return update()
    })
    const s = sync({ write, debounceMs: 1_000 })
    s.notify()
    const first = s.flush()
    await vi.advanceTimersByTimeAsync(10)
    // A write that arrives mid-run must not start a second overlapping render.
    s.notify()
    expect(write).toHaveBeenCalledTimes(1)
    release?.()
    await first
    await vi.advanceTimersByTimeAsync(1_000)
    expect(write).toHaveBeenCalledTimes(2)
  })
})

describe('failures stay out of the writer', () => {
  it('reports a failed run to the caller that asked for errors', async () => {
    const onError = vi.fn()
    const s = sync({
      write: async () => { throw new Error('marker missing') },
      onError,
    })
    s.notify()
    await expect(s.flush()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('keeps scheduling after a failure', async () => {
    let attempts = 0
    const write = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('first run fails')
      return update()
    })
    const s = sync({ write, debounceMs: 1_000 })
    s.notify()
    await s.flush()
    s.notify()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(write).toHaveBeenCalledTimes(2)
  })
})

describe('dispose', () => {
  it('stops a pending write', async () => {
    const write = vi.fn(async () => update())
    const s = sync({ write, debounceMs: 1_000 })
    s.notify()
    s.dispose()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(write).not.toHaveBeenCalled()
    expect(s.dirty).toBe(false)
  })

  it('ignores a change after dispose', async () => {
    const write = vi.fn(async () => update())
    const s = sync({ write, debounceMs: 1_000 })
    s.dispose()
    s.notify()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('state', () => {
  it('reports dirty between a change and its write', async () => {
    const s = sync({ debounceMs: 1_000 })
    expect(s.dirty).toBe(false)
    s.notify()
    expect(s.dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(s.dirty).toBe(false)
  })
})

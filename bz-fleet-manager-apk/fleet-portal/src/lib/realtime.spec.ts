/// <reference types="node" />
// tsconfig.app.json scopes `types` to `vite/client` only (app/browser code
// should never need Node builtins) — this one file is the exception, since
// the guard test below has to walk the filesystem. The reference is scoped
// to this file alone rather than widening the project-wide `types` array.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOKEN_STORAGE_KEY } from './constants'

// One socket per tab (spec §9): every subscriber shares it, and it closes
// when the last one leaves.
class FakeSocket {
  static instances: FakeSocket[] = []
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false
  url: string
  constructor(url: string) { this.url = url; FakeSocket.instances.push(this) }
  /** The browser fires this when the handshake completes; the fake has to be
   *  told to, since nothing here is real. */
  open() { this.onopen?.() }
  close() { this.closed = true; this.onclose?.() }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

describe('lib/realtime', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    localStorage.setItem(TOKEN_STORAGE_KEY, 'tok')
  })
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

  it('opens one socket for many subscribers, routes frames by type, and closes with the last unsubscribe', async () => {
    const rt = await import('./realtime')
    const locks: unknown[] = []
    const board: unknown[] = []
    const offA = rt.subscribe('load_lock', (f) => locks.push(f))
    const offB = rt.subscribe('board_update', (f) => board.push(f))
    expect(FakeSocket.instances).toHaveLength(1)
    FakeSocket.instances[0].emit({ type: 'load_lock', loadId: 'a', by: 'Maria' })
    FakeSocket.instances[0].emit({ type: 'board_update', ids: ['a'] })
    FakeSocket.instances[0].emit('not json at all')
    expect(locks).toEqual([{ type: 'load_lock', loadId: 'a', by: 'Maria' }])
    expect(board).toEqual([{ type: 'board_update', ids: ['a'] }])
    offA()
    expect(rt.__state().open).toBe(true)
    offB()
    expect(rt.__state().open).toBe(false)
    expect(FakeSocket.instances[0].closed).toBe(true)
  })

  it('does not open without a token, and reconnects after a drop while someone still listens', async () => {
    vi.useFakeTimers()
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    const rt = await import('./realtime')
    rt.subscribe('load_lock', () => {})
    expect(FakeSocket.instances).toHaveLength(0)
    localStorage.setItem(TOKEN_STORAGE_KEY, 'tok')
    rt.subscribe('load_unlock', () => {})
    expect(FakeSocket.instances).toHaveLength(1)
    FakeSocket.instances[0].onclose?.()
    vi.advanceTimersByTime(5_000)
    expect(FakeSocket.instances).toHaveLength(2)
    rt.close()
    vi.useRealTimers()
  })

  // F7: a socket that dropped and came back missed whatever happened while it
  // was down, so a subscriber whose state is a live projection of frames (the
  // lock badges) has to be told to go and re-read the snapshot.
  it('dispatches a $open frame on every connect, including a reconnect', async () => {
    vi.useFakeTimers()
    const rt = await import('./realtime')
    const opens: unknown[] = []
    rt.subscribe(rt.OPEN, (f) => opens.push(f))
    rt.subscribe('load_lock', () => {})
    expect(FakeSocket.instances).toHaveLength(1)
    FakeSocket.instances[0].open()
    expect(opens).toEqual([{ type: '$open' }])

    FakeSocket.instances[0].onclose?.()
    vi.advanceTimersByTime(5_000)
    expect(FakeSocket.instances).toHaveLength(2)
    FakeSocket.instances[1].open()
    expect(opens).toEqual([{ type: '$open' }, { type: '$open' }])
    rt.close()
    vi.useRealTimers()
  })

  it('is the only module in src/ that constructs a WebSocket', () => {
    // Spec §9: one socket per tab. Two sockets means two reconnect policies,
    // two auth refreshes and two chances to miss a frame — which is what this
    // slice exists to end.
    // Derived from this module's own location (not process.cwd()): the latter
    // only works when vitest is invoked from the fleet-portal directory. Not
    // `new URL(import.meta.url).pathname` either — on Windows that yields a
    // leading-slash path like `/E:/...` that readdirSync rejects; fileURLToPath
    // is the one conversion that gets a real filesystem path back out.
    // This file sits at src/lib/realtime.spec.ts: one dirname strips the
    // filename (-> src/lib), a second strips lib (-> src), a third strips
    // src (-> the fleet-portal root).
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|vue)$/.test(e)) files.push(full)
      }
    }
    walk(join(root, 'src'))
    // Built from parts, not one literal string: a contiguous literal would
    // itself contain the exact substring it's searching for, since this file
    // is walked too — and would flag itself as its own offender.
    const needle = ['new', 'WebSocket('].join(' ')
    const offenders = files
      .filter((f) => readFileSync(f, 'utf8').includes(needle))
      .map((f) => relative(root, f).split('\\').join('/'))
    expect(offenders).toEqual(['src/lib/realtime.ts'])
  })
})

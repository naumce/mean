import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOKEN_STORAGE_KEY } from './constants'

// Same fake-socket harness as realtime.spec.ts, but `url` is declared as a
// plain field and assigned in the constructor body rather than written as a
// TS parameter property — this file must type-check under
// tsconfig.app.json's `erasableSyntaxOnly`, which forbids parameter
// properties (see task-7-report.md's Fix round 1 note).
class FakeSocket {
  static instances: FakeSocket[] = []
  url: string
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(url: string) { this.url = url; FakeSocket.instances.push(this) }
  close() { this.closed = true; this.onclose?.() }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

describe('lib/realtime close()', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    localStorage.setItem(TOKEN_STORAGE_KEY, 'tok')
  })
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

  it('is terminal: no reconnect while subscribers remain, and a later subscribe() opens fresh', async () => {
    vi.useFakeTimers()
    const rt = await import('./realtime')

    rt.subscribe('load_lock', () => {})
    expect(FakeSocket.instances).toHaveLength(1)

    rt.close()
    // Before the fix, the closed socket's own onclose handler would see
    // handlers.size > 0 and schedule a reconnect here.
    vi.advanceTimersByTime(5_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(rt.__state().open).toBe(false)

    rt.subscribe('load_lock', () => {})
    expect(FakeSocket.instances).toHaveLength(2)
    expect(rt.__state().open).toBe(true)

    vi.useRealTimers()
  })
})

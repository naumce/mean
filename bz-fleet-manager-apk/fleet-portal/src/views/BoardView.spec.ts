import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBoardStore } from '../stores/board'
import BoardView from './BoardView.vue'

vi.mock('../stores/board', () => ({ useBoardStore: vi.fn() }))
const mockedUse = vi.mocked(useBoardStore)

function stub(overrides: Record<string, unknown> = {}) {
  return {
    lanes: [{ id: 'd1', name: 'Dana', status: 'active' }],
    trips: [
      { id: 't1', identifier: 'TR-1', status: 'assigned', driverId: 'd1', scheduledStart: '2026-08-21T09:00:00.000Z', scheduledEnd: '2026-08-21T12:00:00.000Z', stopCount: 2 },
      { id: 't2', identifier: 'TR-BL', status: 'pending', driverId: null, scheduledStart: null, scheduledEnd: null, stopCount: 1 },
    ],
    loading: false,
    error: null,
    config: { fromDate: new Date('2026-08-21T00:00:00.000Z'), toDate: new Date('2026-08-21T00:00:00.000Z'), dayStartHour: 6, dayEndHour: 20, boardWidthPx: 1200 },
    load: vi.fn(),
    ...overrides,
  }
}

describe('BoardView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedUse.mockReset()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads on mount and renders a lane per driver with its scheduled trip', () => {
    const s = stub()
    mockedUse.mockReturnValue(s as unknown as ReturnType<typeof useBoardStore>)
    const wrapper = mount(BoardView)
    expect(s.load).toHaveBeenCalled()
    const lane = wrapper.find('[data-lane="d1"]')
    expect(lane.exists()).toBe(true)
    expect(lane.text()).toContain('Dana')
    expect(lane.find('[data-trip="t1"]').exists()).toBe(true)
  })

  it('shows unscheduled trips in the backlog strip', () => {
    const s = stub()
    mockedUse.mockReturnValue(s as unknown as ReturnType<typeof useBoardStore>)
    const wrapper = mount(BoardView)
    const backlog = wrapper.find('[data-testid="board-backlog"]')
    expect(backlog.text()).toContain('TR-BL')
    expect(backlog.find('[data-trip="t1"]').exists()).toBe(false)
  })
})

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useBoardStore } from './board'

vi.mock('../lib/api', () => ({ api: { get: vi.fn() } }))
const mockedGet = vi.mocked(api.get)

describe('board store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
  })

  it('load() fetches the window and populates lanes and trips', async () => {
    mockedGet.mockResolvedValue({
      data: {
        lanes: [{ id: 'd1', name: 'Dana', status: 'active' }],
        trips: [
          {
            id: 't1', identifier: 'TR-1', status: 'assigned', driverId: 'd1',
            scheduledStart: '2026-08-21T09:00:00.000Z', scheduledEnd: '2026-08-21T12:00:00.000Z', stopCount: 2,
          },
        ],
      },
    })
    const board = useBoardStore()
    board.fromDate = new Date('2026-08-21T00:00:00.000Z')
    board.toDate = new Date('2026-08-21T00:00:00.000Z')

    await board.load()

    expect(mockedGet).toHaveBeenCalledOnce()
    expect(board.lanes).toHaveLength(1)
    expect(board.trips[0].identifier).toBe('TR-1')
    expect(board.config.dayStartHour).toBe(6)
  })
})

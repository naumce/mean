import { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acceptTender,
  acquireLock,
  api,
  attachAuthToken,
  type Carrier,
  createAssignment,
  declineTender,
  fetchCarriers,
  fetchLocks,
  planAssignment,
  releaseLock,
  type Lock,
} from './api'
import { TOKEN_STORAGE_KEY } from './constants'

function baseConfig(): InternalAxiosRequestConfig {
  return { headers: new AxiosHeaders() } as InternalAxiosRequestConfig
}

describe('attachAuthToken', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('attaches Authorization: Bearer <token> when a token exists', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'abc123')

    const result = attachAuthToken(baseConfig())

    expect(result.headers.get('Authorization')).toBe('Bearer abc123')
  })

  it('does not set an Authorization header when no token exists', () => {
    const result = attachAuthToken(baseConfig())

    expect(result.headers.get('Authorization')).toBeUndefined()
  })
})

// Task 2: the lock + plan/assign client. Each method is a thin wrapper over
// the shared `api` axios instance, so these tests spy directly on its verbs
// (get/post/patch/delete) rather than mocking a network layer — the same
// instance every store already uses, exercised the same way.
describe('lock + plan/assign client', () => {
  const sampleLock: Lock = {
    laneId: 'drv-1',
    orgId: 'org-1',
    dispatcherId: 'disp-1',
    name: 'Dana Dispatcher',
    since: 1000,
    expiresAt: 91000,
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('acquireLock POSTs {laneId} and resolves with the lock', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: { lock: sampleLock } })

    const result = await acquireLock('drv-1')

    expect(spy).toHaveBeenCalledWith('/dispatcher/locks', { laneId: 'drv-1' })
    expect(result).toEqual({ lock: sampleLock })
  })

  it('acquireLock rejects on a 409 with error.response.data.lock intact — the toast needs the holder', async () => {
    const conflict = {
      isAxiosError: true,
      response: { status: 409, data: { error: 'ENTITY_ALREADY_LOCKED', lock: sampleLock } },
    }
    vi.spyOn(api, 'post').mockRejectedValueOnce(conflict)

    await expect(acquireLock('drv-1')).rejects.toMatchObject({
      response: { data: { lock: sampleLock } },
    })
  })

  it('releaseLock DELETEs /dispatcher/locks/:laneId', async () => {
    const spy = vi.spyOn(api, 'delete').mockResolvedValueOnce({ data: undefined })

    await releaseLock('drv-1')

    expect(spy).toHaveBeenCalledWith('/dispatcher/locks/drv-1')
  })

  it('fetchLocks GETs /dispatcher/locks and resolves with the snapshot', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ data: { locks: [sampleLock] } })

    const result = await fetchLocks()

    expect(spy).toHaveBeenCalledWith('/dispatcher/locks')
    expect(result.locks).toEqual([sampleLock])
  })

  it('planAssignment PATCHes /dispatcher/assignments/:id/plan with the body verbatim', async () => {
    const verdict = { feasible: true, conflicts: [], plan: {}, economics: {} }
    const spy = vi.spyOn(api, 'patch').mockResolvedValueOnce({ data: verdict })

    const body = { driverId: 'd2', availableAt: 12345, dryRun: true }
    const result = await planAssignment('a1', body)

    expect(spy).toHaveBeenCalledWith('/dispatcher/assignments/a1/plan', body)
    expect(result).toEqual(verdict)
  })

  it('createAssignment POSTs /dispatcher/assignments with the body verbatim', async () => {
    const verdict = { feasible: false, conflicts: [{ kind: 'hos', severity: 'block', detail: 'x' }], plan: {}, economics: {} }
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: verdict })

    const body = { loadId: 'l1', driverId: 'd1', tractorId: 't1', trailerId: 'tr1', dryRun: true, tender: true }
    const result = await createAssignment(body)

    expect(spy).toHaveBeenCalledWith('/dispatcher/assignments', body)
    expect(result).toEqual(verdict)
  })

  it('acceptTender POSTs the accept endpoint with no body', async () => {
    const assignment = { id: 'a1', loadId: 'l1', driverId: 'd1', tractorId: null, trailerId: null, status: 'assigned', plannedStart: '', plannedEnd: '' }
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: { assignment } })

    const result = await acceptTender('a1')

    expect(spy).toHaveBeenCalledWith('/dispatcher/assignments/a1/tender/accept')
    expect(result).toEqual({ assignment })
  })

  it('declineTender POSTs the decline endpoint with a reason when given', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: undefined })

    await declineTender('a1', 'wrong equipment')

    expect(spy).toHaveBeenCalledWith('/dispatcher/assignments/a1/tender/decline', { reason: 'wrong equipment' })
  })

  it('declineTender omits reason from the body when none is given', async () => {
    const spy = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: undefined })

    await declineTender('a1')

    expect(spy).toHaveBeenCalledWith('/dispatcher/assignments/a1/tender/decline', {})
  })
})

// T1 Carrier Layer, Task 6: same thin-wrapper convention as the lock client above.
describe('carrier client', () => {
  const sampleCarrier: Carrier = {
    id: 'c1',
    name: 'Acme Trucking',
    mcNumber: 'MC123',
    dotNumber: 'DOT456',
    status: 'active',
    mpg: 6.5,
    dieselCentsPerGal: 410,
    driverPayCentsPerMi: 60,
    fixedCentsPerMi: 15,
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fetchCarriers GETs /dispatcher/carriers and resolves with the roster verbatim, nulls included', async () => {
    const inheriting: Carrier = { ...sampleCarrier, id: 'c2', mpg: null, dieselCentsPerGal: null, driverPayCentsPerMi: null, fixedCentsPerMi: null }
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce({ data: [sampleCarrier, inheriting] })

    const result = await fetchCarriers()

    expect(spy).toHaveBeenCalledWith('/dispatcher/carriers')
    expect(result).toEqual([sampleCarrier, inheriting])
  })
})

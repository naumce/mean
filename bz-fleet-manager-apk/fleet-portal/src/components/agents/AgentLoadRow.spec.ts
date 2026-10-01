import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { describe, expect, it } from 'vitest'
import AgentLoadRow from './AgentLoadRow.vue'
import type { AgentLoadRowData } from '../../types/agents'

// Final-review fix round, P2: the row's label must never fall back to the
// full UUID. agentsOverview.ts's `displayLoadNo` already returns null when a
// load has no board number, order ref or external id — this row then shows
// a short id fragment instead.
async function testRouter(): Promise<Router> {
  const Stub = { template: '<div />' }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/cockpit', component: Stub }] })
  await router.push('/')
  await router.isReady()
  return router
}

function load(overrides: Partial<AgentLoadRowData> = {}): AgentLoadRowData {
  return {
    loadId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    boardLoadNo: '1042',
    pill: 'watching',
    mode: 'shadow',
    activity: 'watching',
    next: 'Watching. Next check within a minute.',
    nextConfidence: 'known',
    lastEventAt: '2026-09-30T11:59:00.000Z',
    ...overrides,
  }
}

async function mountRow(props: AgentLoadRowData) {
  const router = await testRouter()
  return mount(AgentLoadRow, { props: { load: props }, global: { plugins: [router] } })
}

describe('AgentLoadRow', () => {
  it('shows the board load number when present', async () => {
    const wrapper = await mountRow(load({ boardLoadNo: '1042' }))
    expect(wrapper.text()).toContain('1042')
  })

  it('falls back to "Load <first 8 chars>" — never the full UUID — when there is no board number', async () => {
    const wrapper = await mountRow(load({ boardLoadNo: null, loadId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }))
    expect(wrapper.text()).toContain('Load a1b2c3d4')
    expect(wrapper.text()).not.toContain('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  })

  it('shows the "Invited" badge for an invited load, separate from the mode badge', async () => {
    const wrapper = await mountRow(load({ activity: 'invited', mode: 'shadow' }))
    expect(wrapper.get('[data-testid="load-activity"]').text()).toBe('Invited')
    expect(wrapper.get('[data-testid="load-mode"]').text()).toBe('Shadow')
  })
})

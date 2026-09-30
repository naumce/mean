import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { describe, expect, it } from 'vitest'
import HowItWorksLinks from './HowItWorksLinks.vue'
import type { DemoStoryLogEntry } from '../../types/demo'

const Stub = { template: '<div />' }

async function testRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ai-lab/runs/:id', component: Stub },
      { path: '/cockpit', component: Stub },
      { path: '/supply', component: Stub },
    ],
  })
  await router.push('/cockpit')
  await router.isReady()
  return router
}

async function mountLinks(props: { aiRunId: string | null; log: DemoStoryLogEntry[]; agentTimelineLoadId?: string | null }) {
  const router = await testRouter()
  return mount(HowItWorksLinks, { props: { agentTimelineLoadId: null, ...props }, global: { plugins: [router] } })
}

describe('HowItWorksLinks', () => {
  it('is collapsed by default', async () => {
    const wrapper = await mountLinks({ aiRunId: null, log: [] })
    expect(wrapper.find('[data-testid="how-it-works-toggle"]').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-testid="how-it-works-cockpit"]').exists()).toBe(false)
  })

  it('reveals the links once toggled open', async () => {
    const wrapper = await mountLinks({ aiRunId: 'run-1', log: [] })
    await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')

    expect(wrapper.find('[data-testid="how-it-works-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-testid="how-it-works-ai-run"]').attributes('href')).toBe('/ai-lab/runs/run-1')
    expect(wrapper.find('[data-testid="how-it-works-cockpit"]').attributes('href')).toBe('/cockpit')
    expect(wrapper.find('[data-testid="how-it-works-supply"]').attributes('href')).toBe('/supply')
    expect(wrapper.find('[data-testid="how-it-works-timeline"]').attributes('href')).toBe('/cockpit')
  })

  it('shows a pending placeholder, not a link, when no AI run has started yet', async () => {
    const wrapper = await mountLinks({ aiRunId: null, log: [] })
    await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')

    expect(wrapper.find('[data-testid="how-it-works-ai-run"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="how-it-works-ai-run-pending"]').exists()).toBe(true)
  })

  // Task 6: the Cockpit now supports a `?load=` deep link into its
  // AgentDrawer, so "Night Shift timeline" prefers it once a load is known.
  it('links "Night Shift timeline" to the cockpit deep link once a load is known', async () => {
    const wrapper = await mountLinks({ aiRunId: null, log: [], agentTimelineLoadId: 'L1' })
    await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')

    expect(wrapper.find('[data-testid="how-it-works-timeline"]').attributes('href')).toBe('/cockpit?load=L1')
  })

  it('falls back to the plain /cockpit route when no load is known yet', async () => {
    const wrapper = await mountLinks({ aiRunId: null, log: [], agentTimelineLoadId: null })
    await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')

    expect(wrapper.find('[data-testid="how-it-works-timeline"]').attributes('href')).toBe('/cockpit')
  })

  it('keeps the technical log collapsed until its own toggle is clicked', async () => {
    const wrapper = await mountLinks({
      aiRunId: null,
      log: [{ atMs: Date.parse('2026-09-28T10:00:00.000Z'), stage: 'uncovered', text: 'Load is uncovered.' }],
    })
    await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="how-it-works-log"]').exists()).toBe(false)

    await wrapper.find('[data-testid="how-it-works-log-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="how-it-works-log"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('uncovered')
    expect(wrapper.text()).toContain('Load is uncovered.')
  })

  it('says so when there is nothing logged yet', async () => {
    const wrapper = await mountLinks({ aiRunId: null, log: [] })
    await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')
    await wrapper.find('[data-testid="how-it-works-log-toggle"]').trigger('click')

    expect(wrapper.find('[data-testid="how-it-works-log-empty"]').exists()).toBe(true)
  })
})

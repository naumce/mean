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

async function mountLinks(props: {
  aiRunId: string | null
  log: DemoStoryLogEntry[]
  agentTimelineLoadId?: string | null
  recommendationSource?: 'ai' | 'engine' | null
}) {
  const router = await testRouter()
  return mount(HowItWorksLinks, {
    props: { agentTimelineLoadId: null, recommendationSource: null, ...props },
    global: { plugins: [router] },
  })
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

  // Render follow-up (2026-10-01): the "AI Lab run" line must say so, in
  // plain language, when the dispatch rules — not the model — made the
  // recommendation, rather than reading "not started yet" when a run never
  // happened because the model timed out, or once it did.
  describe('AI Lab run copy, by recommendationSource', () => {
    it('shows the plain link with no caveat when aiRunId is present and the source is ai', async () => {
      const wrapper = await mountLinks({ aiRunId: 'run-1', log: [], recommendationSource: 'ai' })
      await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')

      const link = wrapper.get('[data-testid="how-it-works-ai-run"]')
      expect(link.attributes('href')).toBe('/ai-lab/runs/run-1')
      expect(link.text()).toBe('AI Lab run')
    })

    it('shows the link plus a timed-out caveat when aiRunId is present and the source is engine', async () => {
      const wrapper = await mountLinks({ aiRunId: 'run-1', log: [], recommendationSource: 'engine' })
      await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')

      const link = wrapper.get('[data-testid="how-it-works-ai-run"]')
      expect(link.attributes('href')).toBe('/ai-lab/runs/run-1')
      expect(link.text()).toBe('AI Lab run — timed out; the dispatch rules made the recommendation')
    })

    it('shows "No AI run" text, not a link, when there is no aiRunId and the source is engine', async () => {
      const wrapper = await mountLinks({ aiRunId: null, log: [], recommendationSource: 'engine' })
      await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')

      expect(wrapper.find('[data-testid="how-it-works-ai-run"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="how-it-works-ai-run-pending"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="how-it-works-ai-run-engine"]').text()).toBe('No AI run — the dispatch rules made this recommendation.')
    })

    it('keeps the existing "not started yet" placeholder when there is no aiRunId and no source yet', async () => {
      const wrapper = await mountLinks({ aiRunId: null, log: [], recommendationSource: null })
      await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')

      expect(wrapper.get('[data-testid="how-it-works-ai-run-pending"]').text()).toBe('AI Lab run (not started yet)')
    })

    // Presenter copy rule: none of score/rank/ranking/engine/deterministic/
    // scenario may appear in rendered text — the prop VALUE 'engine' is fine,
    // the words shown to the room are not.
    it('never renders the forbidden words, for any recommendationSource', async () => {
      const FORBIDDEN = /\b(score|rank|ranking|engine|deterministic|scenario)\b/i
      for (const [aiRunId, recommendationSource] of [
        ['run-1', 'ai'], ['run-1', 'engine'], [null, 'engine'], [null, null],
      ] as const) {
        const wrapper = await mountLinks({ aiRunId, log: [], recommendationSource })
        await wrapper.find('[data-testid="how-it-works-toggle"]').trigger('click')
        expect(wrapper.text()).not.toMatch(FORBIDDEN)
      }
    })
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

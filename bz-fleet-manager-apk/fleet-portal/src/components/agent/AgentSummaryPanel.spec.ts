import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentSummaryPanel from './AgentSummaryPanel.vue'
import type { AgentSummary } from '../../stores/nightShift'

// Task 5 (AI Agents Surface plan): the drawer's summary block. Reads the same
// `AgentSummary` the AI Agents overview reads (fleet-backend's
// lib/agentSummary.ts), so this panel must never invent copy the server did
// not send — only the two "how sure is this" suffixes and the two "nothing
// here" fallbacks are the panel's own words.
function summary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    mode: 'shadow',
    activity: 'waiting_reply',
    noticed: 'Unplanned stop',
    recommends: null,
    done: ['Sent chat: Everything OK?'],
    next: "Waiting for the driver's reply. Night Shift re-asks after its cooldown; the exact time is not recorded here.",
    nextConfidence: 'inferred',
    lastEventAt: 1000,
    ...overrides,
  }
}

describe('AgentSummaryPanel', () => {
  it('renders the five labelled rows for a waiting_reply summary, with the inferred suffix on What happens next', () => {
    const wrapper = mount(AgentSummaryPanel, { props: { summary: summary(), shadow: true } })

    expect(wrapper.get('[data-testid="summary-noticed"]').text()).toContain('Unplanned stop')
    expect(wrapper.get('[data-testid="summary-recommends"]').text()).toContain('No recommendation pending.')
    expect(wrapper.get('[data-testid="summary-done"]').text()).toContain('Sent chat: Everything OK?')
    const next = wrapper.get('[data-testid="summary-next"]').text()
    expect(next).toContain("Waiting for the driver's reply")
    expect(next).toContain('(inferred from the timeline)')
    expect(wrapper.get('[data-testid="summary-mode"]').text()).toBe('Shadow')
    expect(wrapper.get('[data-testid="summary-activity"]').text()).toBe('Waiting for reply')
  })

  it('falls back to "Nothing unusual right now." when nothing was noticed', () => {
    const wrapper = mount(AgentSummaryPanel, { props: { summary: summary({ noticed: null }), shadow: false } })
    expect(wrapper.get('[data-testid="summary-noticed"]').text()).toContain('Nothing unusual right now.')
  })

  it('falls back to "No recommendation pending." when there is no recommendation', () => {
    const wrapper = mount(AgentSummaryPanel, { props: { summary: summary({ recommends: null }), shadow: false } })
    expect(wrapper.get('[data-testid="summary-recommends"]').text()).toContain('No recommendation pending.')
  })

  it('shows a recommendation when there is one', () => {
    const wrapper = mount(AgentSummaryPanel, { props: { summary: summary({ recommends: 'driver reports: a breakdown. A customer note is drafted.' }), shadow: false } })
    expect(wrapper.get('[data-testid="summary-recommends"]').text()).toContain('driver reports: a breakdown. A customer note is drafted.')
  })

  it('falls back to "Nothing sent yet." when done is empty', () => {
    const wrapper = mount(AgentSummaryPanel, { props: { summary: summary({ done: [] }), shadow: false } })
    expect(wrapper.get('[data-testid="summary-done"]').text()).toContain('Nothing sent yet.')
  })

  it('shows the shadow note under What it has done only in shadow mode', () => {
    const shadowWrapper = mount(AgentSummaryPanel, { props: { summary: summary({ mode: 'shadow' }), shadow: true } })
    expect(shadowWrapper.get('[data-testid="summary-done"]').text()).toContain('Shadow mode: these were recorded, not sent.')

    const liveWrapper = mount(AgentSummaryPanel, { props: { summary: summary({ mode: 'live' }), shadow: false } })
    expect(liveWrapper.get('[data-testid="summary-done"]').text()).not.toContain('Shadow mode')
  })

  it('adds the "(no recent report)" suffix when nextConfidence is unknown', () => {
    const wrapper = mount(AgentSummaryPanel, {
      props: { summary: summary({ nextConfidence: 'unknown', next: 'Watching. No report from Night Shift in the last 10 minutes — it checks once a minute, so it may be down.' }), shadow: true },
    })
    expect(wrapper.get('[data-testid="summary-next"]').text()).toContain('(no recent report)')
  })

  it('adds no suffix when nextConfidence is known', () => {
    const wrapper = mount(AgentSummaryPanel, {
      props: { summary: summary({ nextConfidence: 'known', next: 'Watching. Next check within a minute.' }), shadow: false },
    })
    const next = wrapper.get('[data-testid="summary-next"]').text()
    expect(next).not.toContain('inferred')
    expect(next).not.toContain('no recent report')
  })

  it('renders the mode and activity badges for every value the server can send', () => {
    const cases: Array<[AgentSummary['mode'], string]> = [['off', 'Off'], ['shadow', 'Shadow'], ['live', 'Live']]
    for (const [mode, label] of cases) {
      const wrapper = mount(AgentSummaryPanel, { props: { summary: summary({ mode }), shadow: mode === 'shadow' } })
      expect(wrapper.get('[data-testid="summary-mode"]').text()).toBe(label)
    }
    const activityCases: Array<[AgentSummary['activity'], string]> = [
      ['off', 'Off'], ['watching', 'Watching'], ['waiting_reply', 'Waiting for reply'],
      ['escalated', 'Escalated'], ['held', 'Held'], ['attention', 'Needs attention'], ['delivered', 'Delivered'],
    ]
    for (const [activity, label] of activityCases) {
      const wrapper = mount(AgentSummaryPanel, { props: { summary: summary({ activity }), shadow: false } })
      expect(wrapper.get('[data-testid="summary-activity"]').text()).toBe(label)
    }
  })

  it('does not render a "Your actions" heading — the drawer owns the action buttons', () => {
    const wrapper = mount(AgentSummaryPanel, { props: { summary: summary(), shadow: false } })
    expect(wrapper.text()).not.toContain('Your actions')
  })
})

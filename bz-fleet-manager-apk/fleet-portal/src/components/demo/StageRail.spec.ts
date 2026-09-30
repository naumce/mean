import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StageRail from './StageRail.vue'
import type { PresenterStageView } from '../../types/demo'

function stages(): PresenterStageView[] {
  return [
    { id: 'uncovered', title: 'Uncovered load', narration: '', status: 'done' },
    { id: 'ai_recommendation', title: 'AI recommendation', narration: '', status: 'done' },
    { id: 'awaiting_approval', title: 'Human approval', narration: '', status: 'current' },
    { id: 'in_transit', title: 'In transit', narration: '', status: 'upcoming' },
    { id: 'delivered', title: 'Delivered', narration: '', status: 'upcoming' },
  ]
}

describe('StageRail', () => {
  it('renders one tile per stage, in order', () => {
    const wrapper = mount(StageRail, { props: { stages: stages() } })
    const items = wrapper.findAll('[data-testid="stage-rail-item"]')
    expect(items).toHaveLength(5)
    expect(items.map((i) => i.attributes('data-stage-id'))).toEqual([
      'uncovered', 'ai_recommendation', 'awaiting_approval', 'in_transit', 'delivered',
    ])
  })

  it('marks each tile with its done/current/upcoming status', () => {
    const wrapper = mount(StageRail, { props: { stages: stages() } })
    const items = wrapper.findAll('[data-testid="stage-rail-item"]')
    expect(items.map((i) => i.attributes('data-status'))).toEqual([
      'done', 'done', 'current', 'upcoming', 'upcoming',
    ])
  })

  it('shows a checkmark only for done tiles', () => {
    const wrapper = mount(StageRail, { props: { stages: stages() } })
    const items = wrapper.findAll('[data-testid="stage-rail-item"]')
    expect(items[0].text()).toContain('✓')
    expect(items[2].text()).not.toContain('✓')
    expect(items[3].text()).not.toContain('✓')
  })

  it('renders every tile title', () => {
    const wrapper = mount(StageRail, { props: { stages: stages() } })
    expect(wrapper.text()).toContain('Uncovered load')
    expect(wrapper.text()).toContain('Human approval')
    expect(wrapper.text()).toContain('Delivered')
  })

  it('renders a badge pill only for tiles that carry one', () => {
    const withBadge = stages().map((s) => (s.id === 'ai_recommendation' ? { ...s, badge: 'AI' as const } : s))
    const wrapper = mount(StageRail, { props: { stages: withBadge } })
    const badge = wrapper.find('[data-testid="stage-badge-ai_recommendation"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('AI')
    expect(wrapper.find('[data-testid="stage-badge-uncovered"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stage-badge-awaiting_approval"]').exists()).toBe(false)
  })

  it('renders the "Dispatch rules" badge text when that is the badge', () => {
    const withBadge = stages().map((s) =>
      s.id === 'ai_recommendation' ? { ...s, badge: 'Dispatch rules' as const } : s,
    )
    const wrapper = mount(StageRail, { props: { stages: withBadge } })
    expect(wrapper.find('[data-testid="stage-badge-ai_recommendation"]').text()).toBe('Dispatch rules')
  })
})

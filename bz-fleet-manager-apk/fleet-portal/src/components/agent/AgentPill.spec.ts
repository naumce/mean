import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentPill from './AgentPill.vue'

// Night Shift on the Board, Task 6, Step 1: the pill renders each of §6.1's
// eight states plus `held` (§17.3) with the right colour class, and the
// tooltip is the last event's own sentence when there is one, else the
// state's meaning from the spec table verbatim.
describe('AgentPill', () => {
  const cases: Array<{ pill: string; label: string; classFragment: string; fallback: string }> = [
    { pill: 'off', label: '—', classFragment: 'text-ink-3', fallback: 'Not assigned yet, or shadow mode off and agent off for this load' },
    { pill: 'watching', label: 'Watching', classFragment: 'bg-emerald-500/15', fallback: 'Trip started; driver invited or tracking, nothing open' },
    { pill: 'asked', label: 'Asked', classFragment: 'bg-amber-500/15', fallback: "A question is open on the driver's page" },
    { pill: 'calling', label: 'Calling', classFragment: 'bg-amber-500/15', fallback: 'A voice rung is in progress or just happened' },
    { pill: 'escalated', label: 'Escalated', classFragment: 'bg-red-500/15', fallback: 'The dispatcher has been emailed (and called, if configured)' },
    { pill: 'delivered', label: 'Delivered', classFragment: 'bg-emerald-500', fallback: 'Arrived; on time or late shown in the tooltip' },
    { pill: 'attention', label: 'Attention', classFragment: 'border-red-500', fallback: "The agent could not start or continue (missing phone, unreadable appointment, route unusable)" },
    { pill: 'shadow', label: 'Shadow', classFragment: 'bg-blue-500/15', fallback: 'The agent is watching but not allowed to talk' },
    { pill: 'held', label: 'Held', classFragment: 'bg-violet-500/15', fallback: 'A human holds it — the agent is watching but silent' },
  ]

  for (const c of cases) {
    it(`renders ${c.pill} with its colour class and the fallback tooltip when there is no line`, () => {
      const w = mount(AgentPill, { props: { pill: c.pill, loadId: 'l1' } })
      const el = w.get('[data-agent-pill]')
      expect(el.text()).toBe(c.label)
      expect(el.classes().join(' ')).toContain(c.classFragment)
      expect(el.attributes('title')).toBe(c.fallback)
    })
  }

  it('uses the last event line as the tooltip when one is given, over the fallback', () => {
    const w = mount(AgentPill, { props: { pill: 'asked', line: 'Asked at 02:14, no reply yet', loadId: 'l1' } })
    expect(w.get('[data-agent-pill]').attributes('title')).toBe('Asked at 02:14, no reply yet')
  })

  it('treats a missing or unknown pill as off', () => {
    expect(mount(AgentPill, { props: { loadId: 'l1' } }).get('[data-agent-pill]').text()).toBe('—')
    expect(mount(AgentPill, { props: { pill: 'nonsense', loadId: 'l1' } }).get('[data-agent-pill]').text()).toBe('—')
  })

  it('clicking emits open-agent with the load id, and does not bubble as a row click', async () => {
    const w = mount(AgentPill, { props: { pill: 'watching', loadId: 'l42' } })
    await w.get('[data-agent-pill]').trigger('click')
    expect(w.emitted('open-agent')).toEqual([['l42']])
  })
})

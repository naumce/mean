import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ConfirmDelete from './ConfirmDelete.vue'

const d = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, label: `D-${i}` }))
const b = (n: number, reason: string, p = 'B') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, label: `${p}-${i}`, reason }))
const mountIt = (props: Record<string, unknown>) => mount(ConfirmDelete, { props: { loading: false, deletable: [], blocked: [], ...props } })

describe('ConfirmDelete', () => {
  it('shows a checking state with no Delete button while loading', () => {
    const w = mountIt({ loading: true, count: 3 })
    expect(w.text()).toContain('Checking 3 loads…')
    expect(w.find('[data-confirm]').exists()).toBe(false)
  })

  it('mixed: both sections, counts, grouped reasons, button says the deletable count', () => {
    const w = mountIt({ deletable: d(6), blocked: [...b(32, 'Delivered — kept as history'), ...b(2, 'Assigned to a driver or in progress', 'A')] })
    expect(w.find('h2').text()).toBe('Delete 6 loads?')
    expect(w.find('[data-testid="delete-deletable"]').text()).toContain('Will be deleted (6)')
    expect(w.find('[data-testid="delete-deletable"]').text()).toContain("This can't be undone.")
    const blocked = w.find('[data-testid="delete-blocked"]')
    expect(blocked.text()).toContain("Can't be deleted (34)")
    expect(blocked.text()).toContain('Delivered — kept as history (32)')
    expect(blocked.text()).toContain('Assigned to a driver or in progress (2)')
    expect(blocked.find('[data-blocked-group] li').text()).toBe('B-0')
    expect(w.find('[data-confirm]').text()).toBe('Delete 6 loads')
  })

  it('singular wording for one load', () => {
    const w = mountIt({ deletable: d(1) })
    expect(w.find('h2').text()).toBe('Delete 1 load?')
    expect(w.find('[data-confirm]').text()).toBe('Delete 1 load')
  })

  it('all blocked: no Delete button, only Close', async () => {
    const w = mountIt({ blocked: b(2, 'Delivered — kept as history') })
    expect(w.find('h2').text()).toBe('None of the selected loads can be deleted')
    expect(w.find('[data-confirm]').exists()).toBe(false)
    expect(w.find('[data-testid="delete-deletable"]').exists()).toBe(false)
    const close = w.find('[data-cancel]')
    expect(close.text()).toBe('Close')
    await close.trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('none blocked: no blocked section; confirm emits', async () => {
    const w = mountIt({ deletable: d(2) })
    expect(w.find('[data-testid="delete-blocked"]').exists()).toBe(false)
    await w.find('[data-confirm]').trigger('click')
    expect(w.emitted('confirm')).toHaveLength(1)
  })
})

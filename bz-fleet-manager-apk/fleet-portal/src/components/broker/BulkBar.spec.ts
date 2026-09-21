import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BulkBar from './BulkBar.vue'

describe('BulkBar', () => {
  it('is absent with nothing selected and shows the count and actions otherwise', () => {
    expect(mount(BulkBar, { props: { count: 0, busy: false } }).find('[data-bulk]').exists()).toBe(false)
    const w = mount(BulkBar, { props: { count: 3, busy: false } })
    expect(w.text()).toContain('3 loads selected')
    for (const name of ['archive', 'unarchive', 'delete', 'export', 'clear']) {
      w.find(`button[data-action="${name}"]`).trigger('click')
      expect(w.emitted(name)).toBeTruthy()
    }
  })
  // NIT 9: a selection survives a search (deliberately — it is a set the
  // dispatcher built), so the bar has to say when part of it is off-screen
  // rather than showing a count of rows that aren't there.
  it('says how much of the selection the current search is hiding', () => {
    const w = mount(BulkBar, { props: { count: 4, busy: false, hidden: 2 } })
    expect(w.text()).toContain('4 loads selected')
    expect(w.text()).toContain('2 not shown by the current search/filters')
    expect(mount(BulkBar, { props: { count: 4, busy: false, hidden: 0 } }).text()).not.toContain('not shown')
  })

  it('disables the actions while busy', () => {
    const w = mount(BulkBar, { props: { count: 1, busy: true } })
    expect(w.find('button[data-action="delete"]').attributes('disabled')).toBeDefined()
  })
})

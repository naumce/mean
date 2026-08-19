import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DataTable from './DataTable.vue'

const columns = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
]

describe('DataTable', () => {
  it('renders one row per item, with each cell showing the raw value by default', () => {
    const rows = [
      { id: '1', name: 'Dana Dispatcher', email: 'dana@fleet.test' },
      { id: '2', name: 'Sam Driver', email: 'sam@fleet.test' },
    ]

    const wrapper = mount(DataTable, { props: { columns, rows, rowKey: 'id' } })

    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    expect(wrapper.text()).toContain('Dana Dispatcher')
    expect(wrapper.text()).toContain('sam@fleet.test')
  })

  it('renders a scoped cell slot instead of the raw value when provided', () => {
    const rows = [{ id: '1', name: 'Dana Dispatcher', email: 'dana@fleet.test' }]

    const wrapper = mount(DataTable, {
      props: { columns, rows, rowKey: 'id' },
      slots: { 'cell-email': '<template #cell-email="{ value }">Contact: {{ value }}</template>' },
    })

    expect(wrapper.text()).toContain('Contact: dana@fleet.test')
  })

  it('shows the empty-state slot when rows is empty', () => {
    const wrapper = mount(DataTable, {
      props: { columns, rows: [] },
      slots: { empty: 'No drivers yet' },
    })

    expect(wrapper.find('tbody').exists()).toBe(false)
    expect(wrapper.text()).toContain('No drivers yet')
  })

  it('shows the default empty-state text when no empty slot is provided', () => {
    const wrapper = mount(DataTable, { props: { columns, rows: [] } })

    expect(wrapper.text()).toContain('No data yet.')
  })
})

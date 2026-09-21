import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ColumnTools from './ColumnTools.vue'

const columns = [{ id: 'bol', label: 'BOL#', visible: true }, { id: 'rate', label: 'RATE', visible: false }]
describe('ColumnTools', () => {
  it('lists columns with their visibility and emits toggle, move and reset', async () => {
    const w = mount(ColumnTools, { props: { columns } })
    await w.find('button[data-columns]').trigger('click')
    const boxes = w.findAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect((boxes[1].element as HTMLInputElement).checked).toBe(false)
    await boxes[1].setValue(true)
    expect(w.emitted('toggle')?.[0]).toEqual(['rate'])
    await w.find('button[data-move-up="rate"]').trigger('click')
    expect(w.emitted('move')?.[0]).toEqual(['rate', -1])
    await w.find('button[data-reset]').trigger('click')
    expect(w.emitted('reset')).toBeTruthy()
  })
})

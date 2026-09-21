import { flushPromises, mount } from '@vue/test-utils'
import { AxiosError, type AxiosResponse } from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import ImportView from './ImportView.vue'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
}))
const mockedPost = vi.mocked(api.post)
const mockedGet = vi.mocked(api.get)

describe('ImportView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedPost.mockReset()
    mockedGet.mockReset()
    // Every mount loads the webhook key; default to "no key yet".
    mockedGet.mockResolvedValue({ data: { apiKey: null, url: '/api/webhooks/loads' } })
  })

  it('posts pasted CSV to the selected entity and shows the report', async () => {
    mockedPost.mockResolvedValue({
      data: { batchId: 'b1', imported: 2, errors: [{ row: 3, error: 'requiredEquip: Invalid' }] },
    })
    const wrapper = mount(ImportView)

    await wrapper.find('[data-entity="loads"]').trigger('click')
    await wrapper.find('[data-testid="csv-input"]').setValue('externalId,requiredEquip\nL-1,DryVan')
    await wrapper.find('[data-testid="import-btn"]').trigger('click')
    await flushPromises()

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/import/loads', {
      csv: 'externalId,requiredEquip\nL-1,DryVan',
    })
    const report = wrapper.find('[data-testid="import-report"]')
    expect(report.text()).toContain('2 rows imported')
    expect(report.text()).toContain('row 3')
    expect(report.text()).toContain('requiredEquip')
  })

  it('switching entity clears the previous report and targets the new endpoint', async () => {
    mockedPost.mockResolvedValue({ data: { batchId: 'b1', imported: 1, errors: [] } })
    const wrapper = mount(ImportView)
    await wrapper.find('[data-testid="csv-input"]').setValue('email,name\nj@x.com,Jake')
    await wrapper.find('[data-testid="import-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="import-report"]').exists()).toBe(true)

    await wrapper.find('[data-entity="hos"]').trigger('click')
    expect(wrapper.find('[data-testid="import-report"]').exists()).toBe(false)
    await wrapper.find('[data-testid="import-btn"]').trigger('click')
    await flushPromises()
    expect(mockedPost).toHaveBeenLastCalledWith('/dispatcher/import/hos', expect.anything())
  })

  it('preview auto-maps foreign headers and imports canonical rows', async () => {
    mockedPost.mockResolvedValue({ data: { batchId: 'b2', imported: 2, errors: [] } })
    const wrapper = mount(ImportView)

    await wrapper.find('[data-testid="csv-input"]').setValue(
      'Load #,Equipment Type,Origin,Consignee Address,Broker Notes\n' +
        'L-1,DryVan,"Kansas City, MO","Omaha, NE",call ahead\n' +
        'L-2,Reefer,"St. Louis, MO","Wichita, KS",',
    )
    await wrapper.find('[data-testid="preview-btn"]').trigger('click')

    const mapper = wrapper.find('[data-testid="field-mapper"]')
    expect(mapper.exists()).toBe(true)
    // Auto-matched: the four known headers; Broker Notes stays ignored.
    expect((wrapper.find('[data-map-select="0"]').element as HTMLSelectElement).value).toBe('externalId')
    expect((wrapper.find('[data-map-select="4"]').element as HTMLSelectElement).value).toBe('')
    expect(wrapper.find('[data-testid="missing-required"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mapped-preview"]').text()).toContain('Kansas City, MO')

    await wrapper.find('[data-testid="import-btn"]').trigger('click')
    await flushPromises()

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/import/loads', {
      rows: [
        { externalId: 'L-1', requiredEquip: 'DryVan', pickupAddress: 'Kansas City, MO', deliveryAddress: 'Omaha, NE' },
        { externalId: 'L-2', requiredEquip: 'Reefer', pickupAddress: 'St. Louis, MO', deliveryAddress: 'Wichita, KS' },
      ],
    })
  })

  it('blocks import while required fields are unmapped and unblocks once mapped', async () => {
    const wrapper = mount(ImportView)
    await wrapper.find('[data-testid="csv-input"]').setValue('Load #,Stuff\nL-1,x')
    await wrapper.find('[data-testid="preview-btn"]').trigger('click')

    const warning = wrapper.find('[data-testid="missing-required"]')
    expect(warning.text()).toContain('Equipment')
    expect(wrapper.find('[data-testid="import-btn"]').attributes('disabled')).toBeDefined()

    // Map the leftover column to Equipment: the warning shrinks accordingly.
    await wrapper.find('[data-map-select="1"]').setValue('requiredEquip')
    expect(wrapper.find('[data-testid="missing-required"]').text()).not.toContain('Equipment,')
  })

  it('cancel mapping returns to the raw-CSV path', async () => {
    mockedPost.mockResolvedValue({ data: { batchId: 'b3', imported: 1, errors: [] } })
    const wrapper = mount(ImportView)
    await wrapper.find('[data-testid="csv-input"]').setValue('email,name\nj@x.com,Jake')
    await wrapper.find('[data-testid="preview-btn"]').trigger('click')
    expect(wrapper.find('[data-testid="field-mapper"]').exists()).toBe(true)

    await wrapper.find('[data-testid="close-mapper"]').trigger('click')
    expect(wrapper.find('[data-testid="field-mapper"]').exists()).toBe(false)

    await wrapper.find('[data-testid="import-btn"]').trigger('click')
    await flushPromises()
    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/import/loads', {
      csv: 'email,name\nj@x.com,Jake',
    })
  })

  it('webhook card: generate reveals the key and flips the button to rotate', async () => {
    mockedPost.mockResolvedValue({ data: { apiKey: 'whk_abc123', url: '/api/webhooks/loads' } })
    const wrapper = mount(ImportView)
    await flushPromises()

    const btn = wrapper.find('[data-testid="webhook-generate"]')
    expect(btn.text()).toContain('Generate key')
    expect(wrapper.find('[data-testid="webhook-key"]').exists()).toBe(false)

    await btn.trigger('click')
    await flushPromises()

    expect(mockedPost).toHaveBeenCalledWith('/dispatcher/integrations/webhook-key')
    expect(wrapper.find('[data-testid="webhook-key"]').text()).toBe('whk_abc123')
    expect(wrapper.find('[data-testid="webhook-generate"]').text()).toContain('Rotate key')
    expect(wrapper.text()).toContain('x-api-key')
  })

  it('webhook card shows an existing key straight from mount', async () => {
    mockedGet.mockResolvedValue({ data: { apiKey: 'whk_existing', url: '/api/webhooks/loads' } })
    const wrapper = mount(ImportView)
    await flushPromises()

    expect(wrapper.find('[data-testid="webhook-key"]').text()).toBe('whk_existing')
    expect(wrapper.find('[data-testid="webhook-generate"]').text()).toContain('Rotate key')
  })

  it('disables the button with empty input and surfaces API errors', async () => {
    const apiError = new AxiosError('Request failed', '400')
    apiError.response = { data: { error: 'Import requires an org-scoped dispatcher account' } } as AxiosResponse
    mockedPost.mockRejectedValue(apiError)
    const wrapper = mount(ImportView)
    expect(wrapper.find('[data-testid="import-btn"]').attributes('disabled')).toBeDefined()

    await wrapper.find('[data-testid="csv-input"]').setValue('email\nx@x.com')
    await wrapper.find('[data-testid="import-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('org-scoped')
  })
})

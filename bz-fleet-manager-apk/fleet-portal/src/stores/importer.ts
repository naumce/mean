import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'

// Data ingestion (Control Tower screen 9): paste CSV (or a JSON row array)
// per entity, get back the row-level validation report.

export type ImportEntity = 'loads' | 'drivers' | 'hos'

export interface ImportRowError {
  row: number
  error: string
}

export interface ImportReport {
  batchId: string
  imported: number
  errors: ImportRowError[]
}

interface ImporterState {
  submitting: boolean
  report: ImportReport | null
  error: string | null
  webhookKey: string | null
  webhookUrl: string | null
  webhookBusy: boolean
}

export const useImporterStore = defineStore('importer', {
  state: (): ImporterState => ({
    submitting: false,
    report: null,
    error: null,
    webhookKey: null,
    webhookUrl: null,
    webhookBusy: false,
  }),

  actions: {
    async importCsv(entity: ImportEntity, csv: string): Promise<void> {
      this.submitting = true
      this.error = null
      this.report = null
      try {
        const { data } = await api.post<ImportReport>(`/dispatcher/import/${entity}`, { csv })
        this.report = data
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.submitting = false
      }
    },

    /** Canonical-row path used by the field mapper: columns were already
     *  renamed client-side, the server still validates every row. */
    async importRows(entity: ImportEntity, rows: Record<string, string>[]): Promise<void> {
      this.submitting = true
      this.error = null
      this.report = null
      try {
        const { data } = await api.post<ImportReport>(`/dispatcher/import/${entity}`, { rows })
        this.report = data
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.submitting = false
      }
    },

    /** The org's push-ingest credential (Integrations card). */
    async loadWebhookKey(): Promise<void> {
      this.webhookBusy = true
      try {
        const { data } = await api.get<{ apiKey: string | null; url: string }>(
          '/dispatcher/integrations/webhook-key',
        )
        this.webhookKey = data.apiKey
        this.webhookUrl = data.url
      } catch {
        // The card is auxiliary — CSV import must keep working without it.
      } finally {
        this.webhookBusy = false
      }
    },

    /** Generate the first key or rotate the current one (old key dies instantly). */
    async generateWebhookKey(): Promise<void> {
      this.webhookBusy = true
      this.error = null
      try {
        const { data } = await api.post<{ apiKey: string; url: string }>(
          '/dispatcher/integrations/webhook-key',
        )
        this.webhookKey = data.apiKey
        this.webhookUrl = data.url
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.webhookBusy = false
      }
    },

    reset(): void {
      this.report = null
      this.error = null
    },
  },
})

import { defineStore } from 'pinia'
import { extractApiErrorMessage } from '../../lib/errors'
import * as apiKeysApi from '../api/apiKeysApi'
import type { ApiKeySummary } from '../api/apiKeysApi'

export type { ApiKeySummary } from '../api/apiKeysApi'

interface ApiKeysState {
  keys: ApiKeySummary[]
  /** The one raw key value this session has ever seen, right after
   *  creating it — the server never sends it again (spec: "shown once").
   *  Cleared by the component once the dispatcher has copied it, or by the
   *  next `load()`/`create()` call. */
  justCreatedKey: string | null
  loading: boolean
  error: string | null
}

export const useApiKeysStore = defineStore('nightShiftApiKeys', {
  state: (): ApiKeysState => ({
    keys: [],
    justCreatedKey: null,
    loading: false,
    error: null,
  }),

  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        this.keys = await apiKeysApi.fetchKeys()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load your API keys right now.')
      } finally {
        this.loading = false
      }
    },

    async create(name: string): Promise<void> {
      this.error = null
      this.justCreatedKey = null
      const trimmed = name.trim()
      if (!trimmed) {
        this.error = 'Name the key so you can tell it apart later — e.g. "Claude Desktop".'
        return
      }
      this.loading = true
      try {
        const issued = await apiKeysApi.createKey(trimmed)
        this.justCreatedKey = issued.key
        await this.load()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to create a key right now.')
      } finally {
        this.loading = false
      }
    },

    async revoke(id: string): Promise<void> {
      this.error = null
      this.loading = true
      try {
        await apiKeysApi.revokeKey(id)
        await this.load()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to revoke that key right now.')
      } finally {
        this.loading = false
      }
    },

    dismissJustCreated(): void {
      this.justCreatedKey = null
    },
  },
})

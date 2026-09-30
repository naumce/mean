import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { ageLabel } from '../lib/cockpit/format'
import { extractApiErrorMessage } from '../lib/errors'
import type { AgentsOverview } from '../types/agents'

// AI Agents Surface (Task 4): the "AI Agents" page's store. One read
// (GET /dispatcher/agents/overview, built in Task 3), polled every 15s by
// AgentsView. The two getters below turn the raw overview into the exact
// headline/detail copy the plan specifies — Global Constraints "readiness is
// separate from functionality" and "mode is separate from activity" live
// here, not in the view, so the wording can be unit-tested on its own.

export interface StatusCopy {
  headline: string
  detail: string
}

interface AgentsState {
  data: AgentsOverview | null
  loading: boolean
  error: string | null
}

function dispatchStatusFor(dispatch: AgentsOverview['dispatch']): StatusCopy {
  const { model, activity } = dispatch

  if (!model.configured) {
    return {
      headline: 'Rules available · AI not configured',
      detail: 'Drivers are found and checked by the dispatch rules. Add a model server to get reasoned recommendations.',
    }
  }
  if (!model.reachable) {
    return {
      headline: 'Rules available · AI unreachable',
      detail: model.error
        ? `The dispatch rules are working; the model server could not be reached: ${model.error}`
        : 'The dispatch rules are working; the model server could not be reached.',
    }
  }
  if (!model.modelPresent) {
    return {
      headline: 'Rules available · AI model not installed',
      detail: `The model server is reachable, but "${model.model ?? 'the configured model'}" is not installed on it yet.`,
    }
  }
  if (activity.running) {
    return {
      headline: 'Rules available · AI ready',
      detail: activity.running.loadNo ? `Thinking about load ${activity.running.loadNo}` : 'Thinking about a load',
    }
  }
  if (activity.lastRun) {
    const { driverName, confidence, status } = activity.lastRun
    const confidenceLabel = confidence != null ? confidence.toFixed(2) : '—'
    return {
      headline: 'Rules available · AI ready',
      detail: `Last run: ${driverName ?? 'no driver'} (confidence ${confidenceLabel}) · ${status}`,
    }
  }
  return {
    headline: 'Rules available · AI ready',
    detail: 'Drivers are found by the dispatch rules as usual. No AI run has been asked for yet.',
  }
}

function nightShiftStatusFor(nightShift: AgentsOverview['nightShift']): StatusCopy {
  const { service, activity, mode } = nightShift

  if (!service.configured) {
    return {
      headline: 'Not configured',
      detail:
        'No worker address is set on this server, so it cannot run or confirm Night Shift. The states below come from the database and may be stale.',
    }
  }
  if (activity.total === 0) {
    return { headline: 'Ready · nothing watched yet', detail: 'No loads are enabled for Night Shift yet.' }
  }
  const watching = activity.watching + activity.waitingReply
  const needAttention = activity.attention + activity.escalated
  return {
    headline: `${watching} watching · ${needAttention} need attention`,
    detail:
      `${mode.shadowLoads} in shadow mode (messages recorded, not sent) · ${mode.liveLoads} live` +
      ` · ${activity.delivered} delivered · Last report ${ageLabel(service.lastActivityAt, Date.now())}`,
  }
}

export const useAgentsStore = defineStore('agents', {
  state: (): AgentsState => ({
    data: null,
    loading: false,
    error: null,
  }),

  getters: {
    dispatchStatus(state): StatusCopy | null {
      return state.data ? dispatchStatusFor(state.data.dispatch) : null
    },
    nightShiftStatus(state): StatusCopy | null {
      return state.data ? nightShiftStatusFor(state.data.nightShift) : null
    },
  },

  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        const { data } = await api.get<AgentsOverview>('/dispatcher/agents/overview')
        this.data = data
        this.error = null
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to read the AI Agents overview right now.')
      } finally {
        this.loading = false
      }
    },
  },
})

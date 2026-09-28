import axios from 'axios'
import { defineStore } from 'pinia'
import {
  createAssignment,
  fetchDemoStory,
  fetchSuggestEquipment,
  postDemoAction,
  resetDemoStory,
} from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import { useNightShiftStore } from './nightShift'
import type {
  DemoActionBody,
  DemoPresenterStageDef,
  DemoStage,
  DemoStageAction,
  DemoStory,
  DemoStoryLogEntry,
  DemoStoryResponse,
  PresenterStageView,
} from '../types/demo'

// Demo Mode (2026-09-28 plan, Task 2): the `/demo` presenter screen's store.
// Every /demo/story* route 404s unless the server runs DEMO_MODE=true —
// probe() is the only place that decides `available`, same convention
// stores/sim.ts and stores/aiLab.ts already use for their own gated
// surfaces. Every write here follows the codebase's "write, then refetch"
// idiom (stores/fleet.ts, stores/drivers.ts): no action hand-merges a
// partial `{ story }` response into `data` — each one re-runs load()
// afterward so the rail, the action card and the status line always agree
// on one consistent snapshot (the action routes answer only the row, not
// the full GET shape — see types/demo.ts's DemoStoryActionResponse).

/** The three stages where the story is paused for a human's own action
 *  (approve, the driver's reply text, sending the customer update) — the
 *  one condition that must always stop Auto-run from calling next(), since
 *  Task 1's actions.ts only advances a stage with no pending human action. */
const HUMAN_STAGES: readonly DemoStage[] = ['awaiting_approval', 'awaiting_driver_reply', 'awaiting_customer_update']

/** `awaiting_driver_reply`/`awaiting_customer_update`/`delivering` are real
 *  backend stages with their own narration, but the ten-tile rail (spec)
 *  shows each under the tile it belongs to instead of adding three more. */
const PRESENTER_STAGE_ALIAS: Partial<Record<DemoStage, string>> = {
  awaiting_driver_reply: 'driver_contacted',
  awaiting_customer_update: 'escalated',
  delivering: 'delivered',
}

function presenterStageId(stage: DemoStage): string {
  return PRESENTER_STAGE_ALIAS[stage] ?? stage
}

/** The driver's scripted breakdown reply — prefilled so the presenter never
 *  has to type it live in the room, editable because the whole point of
 *  this stage is that it is a real reply proxied to the worker. */
export const DEFAULT_REPLY_TEXT = 'Engine warning. Give me 15 minutes.'

/** Task 1's observe() logs the AI verdict in plain words, e.g. "AI
 *  recommends John Carter (confidence 0.85)" — there is no separate numeric
 *  field on the wire for it, so this reads it back out of the log rather
 *  than inventing one. Missing/unparseable degrades to no parenthetical at
 *  all, never a broken "(confidence undefined)". */
function extractConfidence(log: DemoStoryLogEntry[]): string | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const match = /confidence\s*([0-9]*\.?[0-9]+)/i.exec(log[i].text)
    if (match) return match[1]
  }
  return null
}

/** There is no `recommendedDriverName` field on the wire — observe.ts only
 *  ever names the driver inside the log line it writes on the SAME
 *  transition that sets `recommendedDriverId` ("AI recommends John Carter
 *  (confidence 0.85)." for the AI path, "AI unavailable — using the
 *  deterministic recommendation: John Carter." for the engine fallback; the
 *  no-feasible-driver fallback names no one). Missing/unparseable degrades
 *  to the generic fallback in computeStageAction below, never "undefined". */
function extractRecommendedDriverName(log: DemoStoryLogEntry[]): string | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const text = log[i].text
    const aiMatch = /^AI recommends (.+?) \(confidence/.exec(text)
    if (aiMatch) return aiMatch[1]
    const engineMatch = /^AI unavailable — using the deterministic recommendation: (.+?)\.$/.exec(text)
    if (engineMatch) return engineMatch[1]
  }
  return null
}

function computeStageAction(story: DemoStory, waitingOn: string | null): DemoStageAction | null {
  switch (story.stage) {
    case 'uncovered':
      return { kind: 'ask_ai', label: 'Ask AI for a driver' }
    case 'awaiting_approval': {
      const name = extractRecommendedDriverName(story.log) ?? 'the recommended driver'
      const confidence = extractConfidence(story.log)
      const subline =
        story.recommendationSource === 'ai'
          ? `Recommended by AI${confidence ? ` (confidence ${confidence})` : ''}`
          : 'Recommended by the dispatch rules — AI unavailable'
      // A reset a moment ago queued Night Shift's release of the previous
      // load; approving before it has been applied would be refused, so the
      // button waits with the reason instead of erroring.
      if (waitingOn === 'night_shift_releasing') {
        return {
          kind: 'approve',
          label: `Approve ${name}`,
          subline: 'Night Shift is still releasing the previous demo — about a minute',
          disabled: true,
        }
      }
      return { kind: 'approve', label: `Approve ${name}`, subline }
    }
    case 'awaiting_driver_reply':
      return { kind: 'driver_reply', label: "Send John's reply" }
    case 'awaiting_customer_update':
      // waitingOnFor() (fleet-backend/src/lib/demoStory/waitingOn.ts) answers
      // "resolve" instead of the send action when the escalation carried no
      // draft ("no customer update was proposed (deadline not at risk)") —
      // sending here would fire a real Night Shift command
      // (send_customer_email) that was never actually recommended. `resolve`
      // is the one exception value; anything else (the send token, whatever
      // Task 1 names it, or null) keeps the send button.
      return waitingOn === 'resolve'
        ? { kind: 'resolve', label: 'Continue — no customer update was needed' }
        : { kind: 'customer_update_sent', label: 'Send customer update', subline: 'Demo sink — nothing leaves the system' }
    case 'customer_updated':
      return { kind: 'resolve', label: 'Continue' }
    case 'delivering':
      return { kind: 'skip_arrival', label: 'Skip wait' }
    default:
      return null
  }
}

/** Prefers a human `message` field over the demo route's machine codes —
 *  409 WRONG_STAGE carries none, 503 WORKER_UNAVAILABLE does — before
 *  falling back to the generic extractor. This is a presenter screen, so
 *  even an error line needs to read as a sentence, not a status code. */
function demoErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string; error?: string } | undefined
    if (data?.message) return data.message
    if (data?.error === 'WRONG_STAGE') return 'This step already moved on.'
  }
  return extractApiErrorMessage(error, fallback)
}

interface DemoState {
  available: boolean | null
  data: DemoStoryResponse | null
  busy: boolean
  error: string | null
  autoRun: boolean
  pollTimerId: number | null
}

export const useDemoStore = defineStore('demo', {
  state: (): DemoState => ({
    available: null,
    data: null,
    busy: false,
    error: null,
    autoRun: false,
    pollTimerId: null,
  }),

  getters: {
    /** The current stage's own tile off `stages[]` (id/title/narration) —
     *  null before the first successful load AND before the first-ever
     *  Reset for this org (the GET 200s with `story: null` until then). */
    currentPresenterStage(state): DemoPresenterStageDef | null {
      const story = state.data?.story
      if (!state.data || !story) return null
      const id = presenterStageId(story.stage)
      return state.data.stages.find((s) => s.id === id) ?? null
    },

    /** The ten-tile rail, each annotated done/current/upcoming. `error`
     *  (not one of the ten ids) resolves to "no current tile" rather than
     *  guessing a position — DemoView's error banner carries the real
     *  state in that case. No story yet (never reset) renders every tile
     *  upcoming, same degrade as `error`. */
    presenterStages(state): PresenterStageView[] {
      const data = state.data
      const story = data?.story
      if (!data || !story) return data?.stages.map((s) => ({ ...s, status: 'upcoming' as const })) ?? []
      const currentId = presenterStageId(story.stage)
      const currentIndex = data.stages.findIndex((s) => s.id === currentId)
      return data.stages.map((s, i) => {
        const status: PresenterStageView['status'] =
          currentIndex === -1 ? 'upcoming' : i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming'
        const title = s.id === 'delivered' && story.stage === 'delivering' ? `${s.title} (in progress)` : s.title
        return { ...s, title, status }
      })
    },

    isHumanStage(state): boolean {
      const stage = state.data?.story?.stage
      return stage ? HUMAN_STAGES.includes(stage) : false
    },

    actionForStage(state): DemoStageAction | null {
      const story = state.data?.story
      return story ? computeStageAction(story, state.data?.waitingOn ?? null) : null
    },
  },

  actions: {
    /** A 404 means "not a demo server" — expected and silent, same
     *  convention as stores/sim.ts's own probe(). Any other failure still
     *  fails closed (hide the nav item, show no story) but records why.
     *  Called once from AppShell on shell mount (nav visibility) and again
     *  from DemoView if it mounts before that has resolved. */
    async probe(): Promise<void> {
      try {
        this.data = await fetchDemoStory()
        this.available = true
        this.error = null
      } catch (error) {
        this.available = false
        this.data = null
        if (!(axios.isAxiosError(error) && error.response?.status === 404)) {
          this.error = extractApiErrorMessage(error, 'Unable to read the demo story right now.')
        }
      }
    },

    /** The 3s heartbeat while `/demo` is mounted — the same GET as probe(),
     *  but never touches `available`: a transient blip mid-demo must not
     *  yank the nav item or blank the presenter screen out from under
     *  whoever is driving the room. */
    async load(): Promise<void> {
      try {
        this.data = await fetchDemoStory()
        this.error = null
      } catch (error) {
        this.error = demoErrorMessage(error, 'Unable to read the demo story right now.')
      }
    },

    /** Arms the heartbeat only — the caller does the initial load() itself
     *  (same split as stores/aiLab.ts's loadRun()+startPolling()), so a
     *  fresh mount never waits out a full interval before showing anything. */
    startPolling(intervalMs = 3000): void {
      this.stopPolling()
      this.pollTimerId = window.setInterval(() => {
        void this.load().then(() => {
          if (this.autoRun) void this.maybeAdvance()
        })
      }, intervalMs)
    },

    stopPolling(): void {
      if (this.pollTimerId !== null) {
        window.clearInterval(this.pollTimerId)
        this.pollTimerId = null
      }
    },

    toggleAutoRun(): void {
      this.autoRun = !this.autoRun
    },

    /** Auto-run's own nudge, checked once per poll tick (never chained
     *  through load() itself, so a burst of automatic steps can't outrun
     *  the cadence the room actually sees on screen). Matches the
     *  backend's next() EXACTLY (fleet-backend/src/lib/demoStory/
     *  actions.ts): it only ever advances "uncovered" (-> askAi) and
     *  "customer_updated" (-> resolve) and 409s on every other stage — every
     *  other stage either needs data Auto-run cannot fabricate (an
     *  assignment, driver reply text) or is already moving on its own via
     *  the backend's own observeStory heartbeat. Deliberately NOT derived
     *  from `waitingOn`/`isHumanStage`: `waitingOn` names a pending action
     *  for six different stages (including these same two), so it cannot
     *  tell "next() is valid here" apart from "a human could click
     *  something here" — only the stage itself can. */
    async maybeAdvance(): Promise<void> {
      const stage = this.data?.story?.stage
      if (stage === 'uncovered' || stage === 'customer_updated') await this.next()
    },

    async reset(): Promise<boolean> {
      this.busy = true
      this.error = null
      try {
        await resetDemoStory()
        await this.load()
        return true
      } catch (error) {
        this.error = demoErrorMessage(error, 'Unable to reset the demo right now.')
        return false
      } finally {
        this.busy = false
      }
    },

    async askAi(): Promise<boolean> {
      return this.runAction({ action: 'ask_ai' }, 'Unable to ask AI for a driver right now.')
    },

    /** suggest -> createAssignment -> the demo action, in that order: the
     *  recommended driver still needs a real tractor/trailer pairing before
     *  an Assignment can exist at all — the same pairing the board's own
     *  Suggest panel would offer, not a demo-only shortcut. A 409 from
     *  createAssignment (an existing dispatch-engine rejection) surfaces
     *  its own message the same way any other error here does. */
    async approve(): Promise<boolean> {
      const story = this.data?.story
      if (!story?.loadId || !story.recommendedDriverId) {
        this.error = 'No recommended driver yet.'
        return false
      }
      const { loadId, recommendedDriverId: driverId } = story
      this.busy = true
      this.error = null
      try {
        const equipment = await fetchSuggestEquipment(loadId)
        if (!equipment.tractorId || !equipment.trailerId) {
          this.error = 'No equipment available to assign right now.'
          return false
        }
        const plan = await createAssignment({
          loadId,
          driverId,
          tractorId: equipment.tractorId,
          trailerId: equipment.trailerId,
        })
        const assignmentId = plan.assignment?.id
        if (!assignmentId) {
          this.error = 'The assignment could not be created.'
          return false
        }
        await postDemoAction({ action: 'approve', assignmentId, driverId })
        await this.load()
        return true
      } catch (error) {
        this.error = demoErrorMessage(error, 'Unable to approve this driver right now.')
        return false
      } finally {
        this.busy = false
      }
    },

    async driverReply(text: string): Promise<boolean> {
      return this.runAction({ action: 'driver_reply', text }, "Unable to send John's reply right now.")
    },

    /** The existing send_customer_email command (AgentDrawer's own action,
     *  via the Night Shift store), then the demo action that logs it — the
     *  same two-step order a dispatcher sending it from the drawer would
     *  produce, just without the drawer UI in front of it. */
    async sendCustomerUpdate(): Promise<boolean> {
      const loadId = this.data?.story?.loadId
      if (!loadId) {
        this.error = 'No load to update yet.'
        return false
      }
      this.busy = true
      this.error = null
      try {
        await useNightShiftStore().command(loadId, 'send_customer_email')
        await postDemoAction({ action: 'customer_update_sent' })
        await this.load()
        return true
      } catch (error) {
        this.error = demoErrorMessage(error, 'Unable to send the customer update right now.')
        return false
      } finally {
        this.busy = false
      }
    },

    async resolve(): Promise<boolean> {
      return this.runAction({ action: 'resolve' }, 'Unable to resolve this load right now.')
    },

    async skipArrival(): Promise<boolean> {
      return this.runAction({ action: 'skip_arrival' }, 'Unable to skip the wait right now.')
    },

    async next(): Promise<boolean> {
      return this.runAction({ action: 'next' }, 'Unable to advance the story right now.')
    },

    /** Shared body for the plain post-action-then-refetch actions above
     *  (every one except approve()/sendCustomerUpdate(), which each need an
     *  extra request first). */
    async runAction(body: DemoActionBody, fallback: string): Promise<boolean> {
      this.busy = true
      this.error = null
      try {
        await postDemoAction(body)
        await this.load()
        return true
      } catch (error) {
        this.error = demoErrorMessage(error, fallback)
        return false
      } finally {
        this.busy = false
      }
    },
  },
})

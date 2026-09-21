<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from 'vue'
import { extractApiErrorMessage } from '../../lib/errors'
import {
  useNightShiftStore,
  type AgentCommandKind,
  type AgentForLoad,
  type AgentTimelineEntry,
  type NightShiftApi,
} from '../../stores/nightShift'

// Task 10 (the deep link): this drawer is mounted by BOTH an authenticated
// dispatcher session (BrokerBoardView/CockpitView, via the pill) and a
// session-less phone view (nightshift/views/NightShiftLinkView.vue, opened
// from a status cell's URL with no bearer token at all). Rather than fork the
// component, it fetches and posts through an injected transport (the
// `NightShiftApi` interface, stores/nightShift.ts) — `provide`d by
// NightShiftLinkView as the token-authenticated `linkApi` (see
// nightshift/api/linkApi.ts), defaulting here to today's dispatcher API (the
// Pinia store) so every existing caller of this drawer needs no change.

// Night Shift on the Board (spec §6.4, §17.3): the supervision drawer. One
// component, mounted once by BOTH boards (BrokerBoardView, CockpitView) and
// opened by the `open-agent` event the pill emits, bubbling up through
// BrokerGrid/LegBrick. It owns nothing about the row itself — the header
// fields (LOAD#, customer, carrier, MC) come in as props from whichever
// board's own row data resolved them, because the two boards keep that data
// in two different shapes (Their Board's BoardLoad top/bottom cells vs the
// Cockpit's loadboard BoardLoad fields) and this component does not own
// either.
const props = defineProps<{
  loadId: string | null
  loadNo?: string | null
  customerName?: string | null
  carrierName?: string | null
  carrierMc?: string | null
}>()
const emit = defineEmits<{ close: [] }>()

const store = useNightShiftStore()
const defaultNightShiftApi: NightShiftApi = {
  timeline: (loadId) => store.agentFor(loadId),
  command: (loadId, kind, payload) => store.command(loadId, kind, payload),
}
const nightShiftApi = inject<NightShiftApi>('nightShiftApi', defaultNightShiftApi)

const agent = ref<AgentForLoad | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const open = computed(() => props.loadId !== null)

// Every action posts one command and shows "queued" until the timeline
// reflects it — the worker applies commands on its next poll, up to 60s
// (spec's own words). Only one action is ever in flight from this drawer at
// a time (every button is disabled while one is pending), so a single slot
// is enough and never gets ambiguous about which action it is tracking.
const pending = ref<{ kind: AgentCommandKind; postedAtMs: number } | null>(null)

// Declared here (ahead of the watch below that resets them) rather than down
// with the rest of the action state: the watch on props.loadId clears every
// bit of per-load UI state on a load switch, including these.
const replyText = ref('')
const correcting = ref(false)
const correctedKey = ref('')
const correctNote = ref('')

let pollTimer: ReturnType<typeof setInterval> | undefined

function stopPoll(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

async function refresh(loadId: string): Promise<void> {
  loading.value = true
  try {
    agent.value = await nightShiftApi.timeline(loadId)
    error.value = null
    // A pending action is "queued" only until the timeline actually shows
    // something newer than the moment it was posted — not merely until the
    // request round-trips, which would call an action "done" before the
    // worker ever touched it.
    const newest = agent.value.timeline[0]
    if (pending.value && newest && newest.atMs > pending.value.postedAtMs) pending.value = null
  } catch (e) {
    error.value = extractApiErrorMessage(e, 'Unable to load the agent timeline right now.')
  } finally {
    loading.value = false
  }
}

watch(
  () => props.loadId,
  (loadId) => {
    stopPoll()
    pending.value = null
    replyText.value = ''
    correcting.value = false
    correctedKey.value = ''
    correctNote.value = ''
    if (!loadId) {
      agent.value = null
      error.value = null
      return
    }
    void refresh(loadId)
    // Re-fetch the timeline every 10s while open (the brief's own number).
    pollTimer = setInterval(() => void refresh(loadId), 10_000)
  },
  { immediate: true },
)
onUnmounted(() => stopPoll())

async function runCommand(kind: AgentCommandKind, payload?: unknown): Promise<void> {
  const loadId = props.loadId
  if (!loadId) return
  const postedAtMs = Date.now()
  pending.value = { kind, postedAtMs }
  try {
    await nightShiftApi.command(loadId, kind, payload)
  } catch (e) {
    error.value = extractApiErrorMessage(e, 'Unable to send that action right now.')
    pending.value = null
    return
  }
  // The command is accepted (202), not applied — the queued banner stays up
  // until a poll actually shows it landed. This immediate refresh only
  // covers the (rare) case where the worker was already mid-poll.
  await refresh(loadId)
}

function close(): void {
  emit('close')
}

// --- Header ------------------------------------------------------------
const policy = computed(() => agent.value?.policy ?? null)
const shadowBadge = computed(() => (policy.value ? (policy.value.shadow ? 'Shadow' : 'Live') : null))
const held = computed(() => agent.value?.pill === 'held')

// --- Actions -------------------------------------------------------------
function sendReply(): void {
  const text = replyText.value.trim()
  if (!text || pending.value) return
  void runCommand('reply', { text })
  replyText.value = ''
}
function callNow(): void {
  if (pending.value) return
  void runCommand('call')
}
function stopAgent(): void {
  if (pending.value) return
  void runCommand('stop')
}
function toggleHold(): void {
  if (pending.value) return
  void runCommand(held.value ? 'handback' : 'takeover')
}

// --- Timeline --------------------------------------------------------
const timeline = computed<AgentTimelineEntry[]>(() => agent.value?.timeline ?? [])

// --- Itinerary (slice 2, 2026-09-19) ----------------------------------
// Two views of the same run: what it was PLANNED as (the newest `plan`
// event's `itinerary`) and what is still AHEAD from the truck's last fix
// (the newest `sheet_write`'s `remaining`). The remainder wins once it
// exists; before the first fix the plan is all there is.
interface ItineraryLeg {
  kind: 'drive' | 'stop' | 'wait' | 'break' | 'rest' | 'fuel'
  startMs: number
  endMs: number
  at: { name: string }
  stopType?: string
  late?: boolean
  assumed?: boolean
  dwellSource?: 'history'
}
interface ItineraryView {
  legs: ItineraryLeg[]
  etaAtMs: number
  slackMin: number
  hos?: { feasible: boolean; reason: string | null } | null
  hasAssumptions?: boolean
}
const plannedItinerary = computed<ItineraryView | null>(() => {
  const e = timeline.value.find((x) => x.kind === 'plan' && evidenceOf(x)?.itinerary)
  return e ? (evidenceOf(e)!.itinerary as ItineraryView) : null
})
const remainingItinerary = computed<ItineraryView | null>(() => {
  const e = timeline.value.find((x) => x.kind === 'sheet_write' && evidenceOf(x)?.remaining)
  return e ? (evidenceOf(e)!.remaining as ItineraryView) : null
})
const itinerary = computed(() => remainingItinerary.value ?? plannedItinerary.value)
const itineraryIsLive = computed(() => remainingItinerary.value !== null)
const LEG_ICON: Record<ItineraryLeg['kind'], string> = { drive: '→', stop: '■', wait: '⏳', break: '☕', rest: '🛏', fuel: '⛽' }
const LEG_LABEL: Record<ItineraryLeg['kind'], string> = { drive: 'Drive', stop: 'Stop', wait: 'Wait for window', break: '30-min break', rest: '10-h rest', fuel: 'Fuel (est.)' }
function legTitle(l: ItineraryLeg): string {
  if (l.kind === 'stop') return (l.stopType === 'pickup' ? 'Pickup' : l.stopType === 'delivery' ? 'Delivery' : 'Stop') + ' · ' + l.at.name
  if (l.kind === 'drive') return 'Drive to ' + l.at.name
  return LEG_LABEL[l.kind] + (l.at.name ? ' · ' + l.at.name : '')
}
const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const slackLabel = computed(() => {
  const it = itinerary.value
  if (!it) return ''
  const m = Math.round(it.slackMin)
  return m >= 0 ? `${m} min slack` : `${-m} min LATE`
})

function evidenceOf(entry: AgentTimelineEntry): Record<string, unknown> | null {
  return entry.evidence && typeof entry.evidence === 'object' ? (entry.evidence as Record<string, unknown>) : null
}

/** would_say entries arrive both as an AgentUpdate (kind `would_say`, text
 *  prefixed "would say:") and as an AgentEvent (kind `would_say`, the same
 *  text in evidence.text) — either shape trips this. */
function isWouldSay(entry: AgentTimelineEntry): boolean {
  return entry.kind === 'would_say' || entry.text.toLowerCase().startsWith('would say:')
}

function callOutcome(entry: AgentTimelineEntry): { answered: boolean; transcript: string | null } | null {
  if (entry.kind !== 'call' && entry.kind !== 'dispatcher_call') return null
  const ev = evidenceOf(entry)
  if (!ev) return null
  return { answered: ev.answered === true, transcript: typeof ev.transcript === 'string' ? ev.transcript : null }
}

function escalationReason(entry: AgentTimelineEntry): string | null {
  if (entry.kind !== 'escalation') return null
  const ev = evidenceOf(entry)
  const reason = ev?.reason
  return typeof reason === 'string' ? reason : null
}

function replySituationKey(entry: AgentTimelineEntry): string | null {
  if (entry.kind !== 'reply') return null
  const ev = evidenceOf(entry)
  const key = ev?.situationKey
  return typeof key === 'string' && key ? key : null
}

function replyRawText(entry: AgentTimelineEntry): string | null {
  const ev = evidenceOf(entry)
  const text = ev?.rawText
  return typeof text === 'string' ? text : null
}

// Correct (spec §17.3) re-labels the trip's LAST classification — the
// server's applyCorrect reads the most recent `reply` event, not whichever
// one the dispatcher happens to be looking at — so the button only makes
// sense on the newest classified reply. Offering it on an older one would
// promise a correction the server would not actually apply to that entry.
const latestClassifiedIndex = computed(() => timeline.value.findIndex((e) => replySituationKey(e) !== null))

function openCorrect(): void {
  correcting.value = true
}
function cancelCorrect(): void {
  correcting.value = false
  correctedKey.value = ''
  correctNote.value = ''
}
function submitCorrect(): void {
  if (pending.value) return
  void runCommand('correct', {
    ...(correctedKey.value ? { correctedKey: correctedKey.value } : {}),
    ...(correctNote.value.trim() ? { note: correctNote.value.trim() } : {}),
  })
  correcting.value = false
  correctedKey.value = ''
  correctNote.value = ''
}

// The situation library's keys (night-shift/library/situations.md), for the
// Correct picker. The portal is a browser app with no filesystem access into
// the monorepo and no backend route exposes this file, so — per the brief —
// the keys are hard-coded here rather than read live. Kept in the order the
// library itself lists them (most serious first); update this list by hand
// if situations.md gains or renames a block.
const SITUATION_KEYS: ReadonlyArray<{ key: string; level: 0 | 1 | 2 | 3 }> = [
  { key: 'breakdown', level: 3 },
  { key: 'accident', level: 3 },
  { key: 'medical', level: 3 },
  { key: 'spill', level: 3 },
  { key: 'theft', level: 3 },
  { key: 'stuck', level: 3 },
  { key: 'refusal', level: 3 },
  { key: 'inspection', level: 2 },
  { key: 'customer', level: 2 },
  { key: 'border', level: 2 },
  { key: 'hours', level: 2 },
  { key: 'documents', level: 2 },
  { key: 'overweight', level: 2 },
  { key: 'access', level: 2 },
  { key: 'equipment', level: 2 },
  { key: 'payment', level: 2 },
  { key: 'not_the_driver', level: 2 },
  { key: 'fine', level: 2 },
  { key: 'traffic', level: 1 },
  { key: 'parking', level: 1 },
  { key: 'ferry', level: 1 },
  { key: 'phone', level: 1 },
  { key: 'rest', level: 0 },
  { key: 'fuel', level: 0 },
  { key: 'arrived', level: 0 },
  { key: 'language', level: 0 },
  { key: 'all_good', level: 0 },
]

// --- Send the customer email --------------------------------------------
// Visible only when a draft actually exists (spec §6.4) — an escalation that
// carried a draft (evidence.draftAttached) or a late-arrival draft email
// (evidence.kind === 'arrival_late_draft'), and no `email` entry has landed
// since (newer atMs) to say it was already sent. The timeline carries no
// explicit "draft pending" flag, so this is the closest honest read of it
// without inventing a field the server does not send.
const draftSourceEntry = computed<AgentTimelineEntry | null>(() => {
  const drafted = timeline.value.find((e) => {
    const ev = evidenceOf(e)
    if (e.kind === 'escalation' && ev?.draftAttached === true) return true
    if (e.kind === 'email' && ev?.kind === 'arrival_late_draft') return true
    return false
  })
  return drafted ?? null
})
const hasPendingDraft = computed(() => {
  const source = draftSourceEntry.value
  if (!source) return false
  return !timeline.value.some((e) => e.kind === 'email' && e.atMs > source.atMs)
})
function sendCustomerEmail(): void {
  if (pending.value) return
  void runCommand('send_customer_email')
}

const KIND_LABELS: Record<string, string> = {
  status: 'Status', eta: 'ETA update', delivered: 'Delivered', attention: 'Attention',
  would_say: 'Would say', ping: 'Ping', plan: 'Plan', anomaly: 'Anomaly', action: 'Action',
  reply: 'Driver reply', escalation: 'Escalated', sheet_write: 'Sheet write', email: 'Email',
  call: 'Call', dispatcher_call: 'Boss call',
}
function labelFor(entry: AgentTimelineEntry): string {
  return KIND_LABELS[entry.kind] ?? entry.kind
}
function formatTime(atMs: number): string {
  try {
    return new Date(atMs).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
  } catch {
    return String(atMs)
  }
}
</script>

<template>
  <div v-if="open" class="fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-2xl" data-testid="agent-drawer">
    <!-- Header: spec §6.4 — LOAD#, customer, carrier + MC, policy name, shadow/live badge. -->
    <div class="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <b class="text-sm text-ink" data-testid="drawer-load-no">{{ loadNo || agent?.boardLoadNo || loadId }}</b>
          <span v-if="shadowBadge" class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" :class="shadowBadge === 'Shadow' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-300' : 'bg-green-500/15 text-green-700 dark:text-green-300'" data-testid="drawer-shadow-badge">{{ shadowBadge }}</span>
          <span v-if="policy" class="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-3" data-testid="drawer-policy-name">{{ policy.name }}</span>
        </div>
        <p class="mt-1 truncate text-xs text-ink-2" data-testid="drawer-customer">{{ customerName || '—' }}</p>
        <p class="truncate text-xs text-ink-3" data-testid="drawer-carrier">{{ carrierName || '—' }}<span v-if="carrierMc"> · MC {{ carrierMc }}</span></p>
      </div>
      <button type="button" class="shrink-0 text-sm text-ink-3 hover:text-ink" data-testid="drawer-close" aria-label="Close" @click="close">✕</button>
    </div>

    <p v-if="error" class="mx-4 mt-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-500 dark:bg-red-950/40 dark:text-red-300" data-testid="drawer-error">{{ error }}</p>
    <p v-if="pending" class="mx-4 mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-200" data-testid="queued-banner">
      Queued — {{ pending.kind.replace('_', ' ') }}. Waiting for the worker to apply it (up to 60s).
    </p>

    <!-- Actions (spec §6.4 + §17.3): the same set the email offers, plus supervision. -->
    <div class="flex flex-wrap gap-2 border-b border-line px-4 py-3">
      <button type="button" class="rounded border border-line px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50" data-testid="action-call" :disabled="!!pending || !agent" @click="callNow">Call the driver now</button>
      <button type="button" class="rounded border px-2.5 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50" :class="held ? 'border-brand bg-brand/10 text-brand-ink' : 'border-line text-ink hover:bg-surface-2'" data-testid="action-hold" :disabled="!!pending || !agent" @click="toggleHold">{{ held ? "Hand it back" : "I've got it" }}</button>
      <button v-if="hasPendingDraft" type="button" class="rounded border border-line px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50" data-testid="action-send-customer-email" :disabled="!!pending || !agent" @click="sendCustomerEmail">Send the customer email</button>
      <button type="button" class="ml-auto rounded border border-red-300 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-500 dark:text-red-300 dark:hover:bg-red-950/30" data-testid="action-stop" :disabled="!!pending || !agent" @click="stopAgent">Stop the agent</button>
    </div>

    <!-- The dispatcher's reply box: posts to the driver's page as the dispatcher, same as §6.4. -->
    <form class="flex items-start gap-2 border-b border-line px-4 py-3" data-testid="reply-form" @submit.prevent="sendReply">
      <textarea v-model="replyText" rows="2" placeholder="Reply to the driver as the dispatcher…" class="min-w-0 flex-1 rounded border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink" data-testid="reply-input" />
      <button type="submit" class="shrink-0 rounded bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50" data-testid="reply-send" :disabled="!!pending || !replyText.trim() || !agent">Send</button>
    </form>

    <!-- Itinerary (slice 2): the run ahead, re-timed from the last fix once there is one. -->
    <section v-if="itinerary" class="border-b border-line px-4 py-3" data-testid="itinerary">
      <div class="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-ink-3">
        <span>{{ itineraryIsLive ? 'Ahead · from last fix' : 'Itinerary · as planned' }}</span>
        <span :class="itinerary.slackMin >= 0 ? 'text-emerald-500' : 'text-red-500'" data-testid="itinerary-slack">ETA {{ hhmm(itinerary.etaAtMs) }} · {{ slackLabel }}</span>
      </div>
      <p v-if="plannedItinerary?.hos && !plannedItinerary.hos.feasible" class="mt-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-500" data-testid="itinerary-hos">⚠ {{ plannedItinerary.hos.reason }}</p>
      <ol class="mt-2 space-y-1">
        <li v-for="(l, i) in itinerary.legs" :key="i" class="flex items-baseline gap-2 text-[11px]" :data-leg="l.kind">
          <span class="w-9 shrink-0 font-mono text-ink-3">{{ hhmm(l.startMs) }}</span>
          <span class="w-4 shrink-0 text-center">{{ LEG_ICON[l.kind] }}</span>
          <span class="min-w-0 flex-1 truncate" :class="l.late ? 'font-semibold text-red-500' : 'text-ink-2'">{{ legTitle(l) }}<span v-if="l.late"> · after window</span></span>
          <span v-if="l.assumed" class="shrink-0 rounded bg-surface-3 px-1 text-[9px] text-ink-3" :title="l.dwellSource === 'history' ? 'Not on file — planned from past visits to this place' : 'Not on file — a planning assumption'">{{ l.dwellSource === 'history' ? 'from history' : 'est.' }}</span>
        </li>
      </ol>
    </section>

    <!-- The timeline, newest first (spec §6.4). -->
    <div class="flex-1 overflow-y-auto px-4 py-3">
      <p v-if="loading && timeline.length === 0" class="text-xs text-ink-2">Loading…</p>
      <p v-else-if="timeline.length === 0" class="text-xs text-ink-3">Nothing on this trip yet.</p>
      <ul class="space-y-2">
        <li
          v-for="(entry, i) in timeline"
          :key="`${entry.atMs}-${entry.kind}-${i}`"
          class="rounded-lg border p-2.5 text-xs"
          :class="isWouldSay(entry) ? 'border-blue-300 bg-blue-500/5 dark:border-blue-700' : 'border-line bg-surface-2'"
          data-testid="timeline-entry"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-semibold" :class="isWouldSay(entry) ? 'text-blue-600 dark:text-blue-300' : 'text-ink'">
              <span v-if="isWouldSay(entry)" class="mr-1 rounded bg-blue-500/15 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide" data-testid="would-say-label">Would say</span>
              {{ labelFor(entry) }}
            </span>
            <span class="shrink-0 text-[10px] text-ink-3">{{ formatTime(entry.atMs) }}</span>
          </div>

          <!-- Call: answered/no answer + transcript verbatim. -->
          <template v-if="callOutcome(entry)">
            <p class="mt-1 font-semibold" :class="callOutcome(entry)!.answered ? 'text-green-700 dark:text-green-300' : 'text-ink-2'" data-testid="call-outcome">
              {{ callOutcome(entry)!.answered ? 'Answered' : 'No answer' }}
            </p>
            <p v-if="callOutcome(entry)!.transcript" class="mt-1 whitespace-pre-wrap text-ink-2" data-testid="call-transcript">{{ callOutcome(entry)!.transcript }}</p>
          </template>

          <!-- Escalation: its reason. -->
          <p v-else-if="escalationReason(entry)" class="mt-1 text-ink-2" data-testid="escalation-reason">{{ escalationReason(entry) }}</p>

          <!-- Everything else: the plain text, driver replies show the raw words. -->
          <p v-else class="mt-1 whitespace-pre-wrap text-ink-2" data-testid="entry-text">{{ entry.text }}</p>
          <p v-if="entry.kind === 'reply' && replyRawText(entry) && replyRawText(entry) !== entry.text" class="mt-1 whitespace-pre-wrap text-ink-3" data-testid="reply-raw-text">"{{ replyRawText(entry) }}"</p>

          <!-- Correct: only on the newest classified reply (see comment above latestClassifiedIndex). -->
          <div v-if="i === latestClassifiedIndex" class="mt-2">
            <button v-if="!correcting" type="button" class="rounded border border-line px-2 py-1 text-[11px] font-semibold text-ink-2 hover:bg-surface-3" data-testid="action-correct" @click="openCorrect">Correct — currently "{{ replySituationKey(entry) }}"</button>
            <div v-else class="mt-1 space-y-1.5 rounded border border-line bg-surface p-2" data-testid="correct-form">
              <select v-model="correctedKey" class="w-full rounded border border-line bg-surface-2 px-1.5 py-1 text-[11px] text-ink" data-testid="correct-key">
                <option value="">Choose the actual situation…</option>
                <option v-for="s in SITUATION_KEYS" :key="s.key" :value="s.key">{{ s.key }} (level {{ s.level }})</option>
              </select>
              <textarea v-model="correctNote" rows="2" placeholder="Note (optional)" class="w-full rounded border border-line bg-surface-2 px-1.5 py-1 text-[11px] text-ink" data-testid="correct-note" />
              <div class="flex gap-1.5">
                <button type="button" class="rounded bg-brand px-2 py-1 text-[11px] font-semibold text-brand-ink disabled:cursor-not-allowed disabled:opacity-50" data-testid="correct-submit" :disabled="!!pending" @click="submitCorrect">Submit correction</button>
                <button type="button" class="rounded border border-line px-2 py-1 text-[11px] text-ink-2" data-testid="correct-cancel" @click="cancelCorrect">Cancel</button>
              </div>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

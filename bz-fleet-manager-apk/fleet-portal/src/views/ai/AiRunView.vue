<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import EvidenceSummary from '../../components/ai/EvidenceSummary.vue'
import ProposalCard from '../../components/ai/ProposalCard.vue'
import RunTimeline from '../../components/ai/RunTimeline.vue'
import { formatDurationMs, isActiveRunStatus, RUN_STATUS_CLASSES, runStatusLabel } from '../../lib/aiLabFormat'
import { useAiLabStore } from '../../stores/aiLab'
import type { HumanVerdict } from '../../types/aiLab'

// AI Lab (Qwen Harness v0.1, Task 7): the run page — the observable loop.
// Header (status/termination/duration/tokens/config snapshot), the
// proposal beside the deterministic baseline, the evidence summary, the full
// step timeline, verdict controls, and a plain error panel for failures.
const props = defineProps<{ id: string }>()
const aiLab = useAiLabStore()
const router = useRouter()

async function openRun(id: string): Promise<void> {
  aiLab.stopPolling()
  await aiLab.loadRun(id)
  aiLab.connectRealtime()
  aiLab.startPolling()
}

onMounted(() => {
  void openRun(props.id)
})
// "Run again" navigates run -> run without unmounting this view (same route
// name, a new :id) — same watch-the-param idiom as AgentDrawer's watch on
// loadId, so the timeline/verdict form reload for the new run.
watch(
  () => props.id,
  (id) => {
    void openRun(id)
  },
)
onBeforeUnmount(() => {
  aiLab.stopPolling()
  aiLab.disconnectRealtime()
})

const run = computed(() => aiLab.run)
const isActive = computed(() => !!run.value && isActiveRunStatus(run.value.status))

const verdict = ref<HumanVerdict | null>(null)
const verdictDriverId = ref<string | null>(null)
const verdictNote = ref('')
const submittingVerdict = ref(false)
const verdictFormError = ref<string | null>(null)

// Reset the form whenever the open run changes (a fresh run, or a replay
// landed here) — a stale verdict/note/error must never carry over from a
// previous run.
watch(run, () => {
  verdict.value = null
  verdictDriverId.value = null
  verdictNote.value = ''
  verdictFormError.value = null
})

function chooseVerdict(next: HumanVerdict): void {
  verdict.value = next
  verdictFormError.value = null
  // Accepting means "I agree with Qwen's pick" — always reflect the
  // proposal's own driver, overwriting any earlier selection. "Other" starts
  // empty on purpose: it is a deliberate departure from the proposal, so
  // nothing should be pre-selected for it.
  if (next === 'accept') verdictDriverId.value = run.value?.proposedDecision?.driverId ?? null
}

async function submitVerdict(): Promise<void> {
  if (!run.value || !verdict.value) return
  if (verdict.value === 'other' && !verdictDriverId.value) {
    verdictFormError.value = 'Pick a driver for "Other".'
    return
  }
  submittingVerdict.value = true
  const ok = await aiLab.recordVerdict(run.value.id, {
    verdict: verdict.value,
    driverId: verdictDriverId.value ?? undefined,
    note: verdictNote.value.trim() || undefined,
  })
  submittingVerdict.value = false
  if (!ok) verdictFormError.value = aiLab.error
}

async function onCancel(): Promise<void> {
  if (run.value) await aiLab.cancelRun(run.value.id)
}

async function onReplay(): Promise<void> {
  if (!run.value) return
  const runId = await aiLab.replay(run.value.id)
  if (runId) void router.push({ name: 'ai-run', params: { id: runId } })
}

// Evidence's "supporting steps" are clickable (fix round 1) — a plain DOM
// lookup rather than a shared ref, since RunTimeline owns its own step cards
// and there is no other bridge between the two sibling components; guarded
// with optional chaining since jsdom (this view's own tests) does not
// implement scrollIntoView.
function scrollToStep(seq: number): void {
  document.querySelector(`[data-testid="run-step-${seq}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="ai-run-view">
    <p v-if="aiLab.error" class="text-sm text-red-600" role="alert">{{ aiLab.error }}</p>

    <template v-if="run">
      <div class="rounded-lg border border-line bg-surface p-3 font-mono text-xs" data-testid="run-header">
        <div class="flex flex-wrap items-center gap-3">
          <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold" :class="RUN_STATUS_CLASSES[run.status]" data-testid="run-status">
            {{ runStatusLabel(run.status) }}
          </span>
          <span v-if="run.terminationReason" data-testid="run-termination">{{ run.terminationReason }}</span>
          <span data-testid="run-duration">{{ formatDurationMs(run.stats?.durationMs) }}</span>
          <span data-testid="run-tokens">{{ run.stats?.promptTokens ?? '—' }}/{{ run.stats?.completionTokens ?? '—' }} tok</span>
          <span v-if="run.promptVersion" data-testid="run-prompt-version">{{ run.promptVersion }}</span>
          <span v-if="run.modelConfig" data-testid="run-model">{{ run.modelConfig.model }} · temp {{ run.modelConfig.temperature }} · ctx {{ run.modelConfig.numCtx }}</span>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <button
            v-if="isActive"
            type="button"
            class="rounded border border-red-300 px-2 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50"
            data-testid="run-cancel"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            v-else
            type="button"
            class="rounded border border-line px-2 py-1 text-[11px] font-semibold text-ink-2 hover:bg-surface-2"
            data-testid="run-replay"
            @click="onReplay"
          >
            Run again
          </button>
        </div>
      </div>

      <div v-if="run.status === 'failed' && run.error" class="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-700" data-testid="run-error-panel">
        {{ run.error }}
      </div>
      <div v-else-if="run.reason && !run.proposedDecision" class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800" data-testid="run-incomplete-reason">
        {{ run.reason }}
      </div>

      <ProposalCard :proposal="run.proposedDecision" :baseline="run.baseline" :driver-names="aiLab.driverNames" />

      <EvidenceSummary v-if="run.evidence" :evidence="run.evidence" :driver-names="aiLab.driverNames" @select-step="scrollToStep" />

      <RunTimeline :steps="aiLab.steps" :driver-names="aiLab.driverNames" />

      <div class="rounded-lg border border-line bg-surface p-3 text-xs" data-testid="verdict-form">
        <div class="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-3">Record a verdict</div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="rounded border px-2 py-1 font-semibold"
            :class="verdict === 'accept' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700' : 'border-line text-ink-2'"
            data-testid="verdict-accept"
            @click="chooseVerdict('accept')"
          >
            Accept
          </button>
          <button
            type="button"
            class="rounded border px-2 py-1 font-semibold"
            :class="verdict === 'reject' ? 'border-red-500 bg-red-500/10 text-red-700' : 'border-line text-ink-2'"
            data-testid="verdict-reject"
            @click="chooseVerdict('reject')"
          >
            Reject
          </button>
          <button
            type="button"
            class="rounded border px-2 py-1 font-semibold"
            :class="verdict === 'other' ? 'border-amber-500 bg-amber-500/10 text-amber-700' : 'border-line text-ink-2'"
            data-testid="verdict-other"
            @click="chooseVerdict('other')"
          >
            Other
          </button>
        </div>

        <label v-if="verdict === 'accept' || verdict === 'other'" class="mt-2 flex flex-col gap-1">
          <span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Driver</span>
          <select v-model="verdictDriverId" class="rounded border border-line bg-surface-2 px-2 py-1" data-testid="verdict-driver">
            <option :value="null">— choose —</option>
            <option v-for="c in run.baseline?.candidates ?? []" :key="c.driverId" :value="c.driverId">{{ c.driverName }}</option>
          </select>
        </label>

        <label class="mt-2 flex flex-col gap-1">
          <span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Note</span>
          <textarea v-model="verdictNote" rows="2" class="rounded border border-line bg-surface-2 px-2 py-1" data-testid="verdict-note" />
        </label>

        <p v-if="verdictFormError" class="mt-1 text-[11px] text-red-600" role="alert">{{ verdictFormError }}</p>

        <div class="mt-2 flex items-center gap-2">
          <button
            type="button"
            class="rounded bg-brand px-3 py-1.5 font-mono text-xs font-semibold text-brand-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!verdict || submittingVerdict"
            data-testid="verdict-submit"
            @click="submitVerdict"
          >
            {{ submittingVerdict ? 'Saving…' : 'Save verdict' }}
          </button>
          <span v-if="run.humanVerdict" class="text-[11px] text-ink-3" data-testid="verdict-recorded">recorded: {{ run.humanVerdict }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

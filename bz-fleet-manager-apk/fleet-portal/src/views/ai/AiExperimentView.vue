<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ExperimentConfigCard from '../../components/ai/ExperimentConfigCard.vue'
import ExperimentRunsTable from '../../components/ai/ExperimentRunsTable.vue'
import RunLoadPicker from '../../components/ai/RunLoadPicker.vue'
import { formatDurationMs, formatMean } from '../../lib/aiLabFormat'
import { MAX_BATCH_RUNS, useAiLabStore } from '../../stores/aiLab'
import type { HarnessConfig } from '../../types/aiLab'

// AI Lab (Qwen Harness v0.1, Task 7): one experiment — its editable config,
// a picker to run it against a single uncovered load, "run all uncovered" in
// one click, and the evaluation table (ENGINE vs QWEN vs HUMAN per run).
const props = defineProps<{ id: string }>()
const aiLab = useAiLabStore()
const router = useRouter()

const startingLoadId = ref<string | null>(null)
const batchStarting = ref(false)

async function refresh(): Promise<void> {
  await Promise.all([aiLab.loadExperiment(props.id), aiLab.loadEvaluation(props.id), aiLab.loadUncoveredLoads()])
}

async function onSaveConfig(config: HarnessConfig): Promise<void> {
  await aiLab.updateExperiment(props.id, { config })
}

async function onStartRun(loadId: string): Promise<void> {
  startingLoadId.value = loadId
  await aiLab.startRun(props.id, loadId)
  startingLoadId.value = null
  await Promise.all([aiLab.loadExperiment(props.id), aiLab.loadEvaluation(props.id)])
}

async function onStartBatch(): Promise<void> {
  batchStarting.value = true
  await aiLab.startBatch(props.id, MAX_BATCH_RUNS)
  batchStarting.value = false
  await Promise.all([aiLab.loadExperiment(props.id), aiLab.loadEvaluation(props.id)])
}

function openRun(runId: string): void {
  void router.push({ name: 'ai-run', params: { id: runId } })
}

onMounted(refresh)
// A "Scratch" experiment could be opened straight from the Ask Qwen flow, or
// a dispatcher could navigate experiment -> experiment via the Lab page —
// either way the route's :id changing must reload everything, same as
// AgentDrawer's watch on loadId.
watch(() => props.id, refresh)
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-ink">{{ aiLab.experiment?.name ?? 'Experiment' }}</h1>
      <p class="font-mono text-xs text-ink-2">
        <span data-testid="experiment-model">{{ aiLab.experiment?.model }}</span> ·
        <span data-testid="experiment-prompt-version">{{ aiLab.experiment?.promptVersion }}</span> ·
        <span data-testid="experiment-status">{{ aiLab.experiment?.status }}</span>
      </p>
    </div>

    <p v-if="aiLab.error" class="text-sm text-red-600" role="alert">{{ aiLab.error }}</p>

    <ExperimentConfigCard v-if="aiLab.experiment" :config="aiLab.experiment.config" @save="onSaveConfig" />

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <RunLoadPicker :loads="aiLab.uncoveredLoads" :starting="startingLoadId" @select="onStartRun" />
      <div class="flex items-start rounded-lg border border-line bg-surface p-3 text-xs">
        <button
          type="button"
          class="rounded bg-brand px-3 py-1.5 font-mono text-xs font-semibold text-brand-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="batchStarting"
          data-testid="run-all-uncovered"
          @click="onStartBatch"
        >
          {{ batchStarting ? 'Starting…' : `Run all uncovered (${MAX_BATCH_RUNS})` }}
        </button>
      </div>
    </div>

    <div v-if="aiLab.evaluation" class="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-line bg-surface p-3 font-mono text-[11px] text-ink-2" data-testid="evaluation-summary">
      <span>{{ aiLab.evaluation.summary.runs }} runs</span>
      <span>{{ aiLab.evaluation.summary.proposed }} proposed</span>
      <span>{{ aiLab.evaluation.summary.matchedDeterministicTop }} matched top</span>
      <span>{{ aiLab.evaluation.summary.accepted }} accepted</span>
      <span>{{ aiLab.evaluation.summary.rejected }} rejected</span>
      <!-- Fix round 2: the means are null on a fresh experiment (no proposed
           runs yet) — formatMean/formatDurationMs both render "—", never a
           fabricated 0. -->
      <span>mean {{ formatMean(aiLab.evaluation.summary.meanTurns) }} turns</span>
      <span>mean latency {{ formatDurationMs(aiLab.evaluation.summary.meanLatencyMs) }}</span>
    </div>

    <ExperimentRunsTable :rows="aiLab.evaluation?.rows ?? []" @select="openRun" />
  </div>
</template>

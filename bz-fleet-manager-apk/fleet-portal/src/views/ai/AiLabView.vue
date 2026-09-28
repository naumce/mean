<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ExperimentConfigCard from '../../components/ai/ExperimentConfigCard.vue'
import { useAiLabStore } from '../../stores/aiLab'
import { DEFAULT_HARNESS_CONFIG, DEFAULT_PROMPT_VERSION, type HarnessConfig } from '../../types/aiLab'

// AI Lab (Qwen Harness v0.1, Task 7): the landing page — status banner,
// experiments list, create form. A developer console, not a product screen:
// monospace stats, raw facts, no marketing copy. Routes only ever probe/list
// while the harness is enabled; while disabled every /ai/* route 404s, so
// there is nothing useful to fetch.
const aiLab = useAiLabStore()
const router = useRouter()

const draftName = ref('')
const draftNotes = ref('')
const nameError = ref<string | null>(null)
const creating = ref(false)
// Prefilled from the probed server defaults once known, falling back to the
// harness's own documented defaults before that — ExperimentConfigCard
// re-syncs its own draft whenever this reference changes (its `watch` on
// `props.config`), so the form updates in place once probe() resolves.
const draftConfig = computed<HarnessConfig>(() => aiLab.status?.defaults ?? DEFAULT_HARNESS_CONFIG)

function formatLastRun(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never'
}

async function onCreate(payload: { config: HarnessConfig; promptVersion?: string }): Promise<void> {
  nameError.value = null
  if (!draftName.value.trim()) {
    nameError.value = 'Name is required'
    return
  }
  creating.value = true
  const created = await aiLab.createExperiment({
    name: draftName.value.trim(),
    notes: draftNotes.value.trim() || undefined,
    config: payload.config,
    promptVersion: payload.promptVersion,
  })
  creating.value = false
  if (created) {
    draftName.value = ''
    draftNotes.value = ''
  }
}

function openExperiment(id: string): void {
  void router.push({ name: 'ai-experiment', params: { id } })
}

onMounted(async () => {
  await aiLab.probe()
  if (aiLab.status?.enabled) await aiLab.listExperiments()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-ink">AI Lab (dev)</h1>
      <p class="text-sm text-ink-2">v0.1 — read-only dispatch reasoning; nothing here assigns anything.</p>
    </div>

    <p v-if="aiLab.error" class="text-sm text-red-600" role="alert">{{ aiLab.error }}</p>

    <div v-if="aiLab.status" class="rounded-lg border border-line bg-surface p-3 font-mono text-xs" data-testid="ai-status-banner">
      <div class="flex flex-wrap items-center gap-3">
        <span :class="aiLab.status.enabled ? 'text-emerald-600' : 'text-red-600'" data-testid="status-enabled">
          {{ aiLab.status.enabled ? 'Harness enabled' : 'Harness disabled' }}
        </span>
        <template v-if="aiLab.status.enabled">
          <span data-testid="status-ollama">
            Ollama {{ aiLab.status.ollama.reachable ? 'reachable' : 'unreachable' }}<template v-if="aiLab.status.ollama.version"> · v{{ aiLab.status.ollama.version }}</template>
          </span>
          <span data-testid="status-model">model {{ aiLab.status.ollama.modelPresent ? 'present' : 'missing' }}</span>
          <span data-testid="status-queue">queue: {{ aiLab.status.queue.running ? '1 running' : 'idle' }}, {{ aiLab.status.queue.queued.length }} queued</span>
        </template>
      </div>
      <p v-if="!aiLab.status.enabled" class="mt-1 text-ink-3">Set OLLAMA_URL on the backend to enable the Qwen harness.</p>
    </div>

    <template v-if="aiLab.status?.enabled">
      <div class="rounded-lg border border-line bg-surface p-3" data-testid="create-experiment-form">
        <h2 class="text-sm font-semibold text-ink">New experiment</h2>
        <div class="mt-2 flex flex-col gap-2 text-xs sm:flex-row sm:items-start sm:gap-4">
          <label class="flex flex-1 flex-col gap-1">
            <span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Name</span>
            <input v-model.trim="draftName" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" data-testid="create-name" />
            <span v-if="nameError" class="text-[11px] text-red-600" role="alert">{{ nameError }}</span>
          </label>
          <label class="flex flex-1 flex-col gap-1">
            <span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Notes</span>
            <textarea v-model.trim="draftNotes" rows="1" class="rounded border border-line bg-surface-2 px-2 py-1 text-ink" data-testid="create-notes" />
          </label>
        </div>
        <ExperimentConfigCard
          class="mt-3"
          :config="draftConfig"
          :prompt-version="DEFAULT_PROMPT_VERSION"
          :prompt-versions="aiLab.status?.promptVersions ?? []"
          :saving="creating"
          save-label="Create experiment"
          @save="onCreate"
        />
      </div>

      <div>
        <h2 class="text-sm font-semibold text-ink">Experiments</h2>
        <div class="mt-2 overflow-x-auto rounded-lg border border-line bg-surface">
          <table class="min-w-full divide-y divide-line text-xs">
            <thead class="bg-surface-2 text-[10px] uppercase tracking-wide text-ink-3">
              <tr>
                <th class="px-2 py-2 text-left font-medium">Name</th>
                <th class="px-2 py-2 text-left font-medium">Model</th>
                <th class="px-2 py-2 text-left font-medium">Prompt version</th>
                <th class="px-2 py-2 text-right font-medium">Runs</th>
                <th class="px-2 py-2 text-left font-medium">Last run</th>
                <th class="px-2 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody v-if="aiLab.experiments.length > 0" class="divide-y divide-line">
              <tr
                v-for="exp in aiLab.experiments"
                :key="exp.id"
                class="cursor-pointer hover:bg-surface-2"
                data-testid="experiment-row"
                :data-experiment-id="exp.id"
                @click="openExperiment(exp.id)"
              >
                <td class="px-2 py-2 font-medium text-ink">{{ exp.name }}</td>
                <td class="px-2 py-2 font-mono text-ink-2">{{ exp.model }}</td>
                <td class="px-2 py-2 font-mono text-ink-2">{{ exp.promptVersion }}</td>
                <td class="px-2 py-2 text-right font-mono text-ink-2">{{ exp.runCount }}</td>
                <td class="px-2 py-2 font-mono text-ink-2">{{ formatLastRun(exp.lastRunAt) }}</td>
                <td class="px-2 py-2 text-ink-2">{{ exp.status }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="aiLab.experiments.length === 0" class="p-6 text-center text-xs text-ink-3" data-testid="experiments-empty">
            No experiments yet — create one above.
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

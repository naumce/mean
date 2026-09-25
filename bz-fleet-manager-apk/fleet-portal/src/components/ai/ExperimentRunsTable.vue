<script setup lang="ts">
import { formatDurationMs, RUN_STATUS_CLASSES, runStatusLabel } from '../../lib/aiLabFormat'
import { formatPct } from '../../lib/money'
import type { EvaluationRow } from '../../types/aiLab'

// AI Lab (Qwen Harness v0.1): the experiment page's runs table — one row per
// run, the evaluation columns (task-7 brief), fed straight from
// `GET /ai/experiments/:id/evaluation`'s `rows` rather than the plain run
// summaries, since that endpoint is the one place the deterministic-top /
// rank-of-pick comparison already lives.
defineProps<{ rows: EvaluationRow[] }>()
const emit = defineEmits<{ select: [runId: string] }>()

// Fix round 2: `row.pick === null` (no decision reached at all) and a
// non-null `row.pick` whose own `driverId`/`name` are both null (a decision
// was reached, naming no driver) are different facts — "none" vs "no
// driver" — and must not collapse into the same label.
function pickLabel(row: EvaluationRow): string {
  if (!row.pick) return 'none'
  if (!row.pick.driverId) return 'no driver'
  return row.pick.name ?? row.pick.driverId
}
function topLabel(row: EvaluationRow): string {
  if (!row.deterministicTop) return '—'
  const name = row.deterministicTop.name ?? row.deterministicTop.driverId ?? '—'
  const rank = row.deterministicRankOfPick != null ? ` (pick #${row.deterministicRankOfPick})` : ''
  return `${name}${rank}`
}
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-line bg-surface" data-testid="runs-table">
    <table class="min-w-full divide-y divide-line font-mono text-[11px]">
      <thead class="bg-surface-2 text-[10px] uppercase tracking-wide text-ink-3">
        <tr>
          <th class="px-2 py-2 text-left font-medium">Load / scenario</th>
          <th class="px-2 py-2 text-left font-medium">Status</th>
          <th class="px-2 py-2 text-left font-medium">Termination</th>
          <th class="px-2 py-2 text-left font-medium">Pick</th>
          <th class="px-2 py-2 text-right font-medium">Confidence</th>
          <th class="px-2 py-2 text-left font-medium">Deterministic top</th>
          <th class="px-2 py-2 text-left font-medium">Verdict</th>
          <th class="px-2 py-2 text-right font-medium">Turns</th>
          <th class="px-2 py-2 text-right font-medium">Tool calls</th>
          <th class="px-2 py-2 text-right font-medium">Uniq/rep/inv</th>
          <th class="px-2 py-2 text-right font-medium">Latency</th>
          <th class="px-2 py-2 text-right font-medium">Tokens</th>
          <th class="px-2 py-2 text-center font-medium">Ctx</th>
        </tr>
      </thead>
      <tbody v-if="rows.length > 0" class="divide-y divide-line">
        <tr
          v-for="row in rows"
          :key="row.runId"
          class="cursor-pointer hover:bg-surface-2"
          data-testid="runs-table-row"
          :data-run-id="row.runId"
          @click="emit('select', row.runId)"
        >
          <td class="px-2 py-2 text-ink">
            <div>{{ row.loadRef ?? row.loadId ?? '—' }}</div>
            <div v-if="row.scenario" class="text-ink-3">{{ row.scenario.code }}: {{ row.scenario.title }}</div>
          </td>
          <td class="px-2 py-2">
            <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold" :class="RUN_STATUS_CLASSES[row.status]">{{ runStatusLabel(row.status) }}</span>
          </td>
          <td class="px-2 py-2 text-ink-2">{{ row.terminationReason ?? '—' }}</td>
          <td class="px-2 py-2 text-ink">{{ pickLabel(row) }}</td>
          <td class="px-2 py-2 text-right text-ink-2">{{ row.confidence != null ? formatPct(row.confidence) : '—' }}</td>
          <td class="px-2 py-2 text-ink-2">{{ topLabel(row) }}</td>
          <td class="px-2 py-2 text-ink-2">{{ row.humanVerdict ?? 'pending' }}</td>
          <td class="px-2 py-2 text-right text-ink-2">{{ row.turns }}</td>
          <td class="px-2 py-2 text-right text-ink-2">{{ row.toolCalls }}</td>
          <td class="px-2 py-2 text-right text-ink-2">{{ row.uniqueTools }}/{{ row.repeatedCalls }}/{{ row.invalidCalls }}</td>
          <td class="px-2 py-2 text-right text-ink-2">{{ formatDurationMs(row.latencyMs) }}</td>
          <td class="px-2 py-2 text-right text-ink-2">{{ row.promptTokens ?? '—' }}/{{ row.completionTokens ?? '—' }}</td>
          <td class="px-2 py-2 text-center">
            <span
              v-if="row.contextPressure"
              class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
              data-testid="ctx-pressure-badge"
              title="A call in this run passed 85% of numCtx — Ollama may have silently dropped earlier messages."
            >ctx!</span>
            <span v-else class="text-ink-3">—</span>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="rows.length === 0" class="p-6 text-center text-xs text-ink-3" data-testid="runs-table-empty">No runs yet for this experiment.</div>
  </div>
</template>

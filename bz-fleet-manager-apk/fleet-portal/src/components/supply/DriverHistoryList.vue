<script setup lang="ts">
import type { DriverHistoryRow } from '../../types/supply'

// Last 10 loads (drawer section 5) — driverSupply.ts's select() already
// requests history with limit=10, so this component just renders whatever
// it's given.
defineProps<{ history: DriverHistoryRow[] }>()

function completedLabel(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}
</script>

<template>
  <section class="px-4 py-3" data-testid="history-list">
    <h3 class="text-[11px] font-bold uppercase tracking-wider text-ink-3">Last {{ history.length }} loads</h3>
    <ul v-if="history.length" class="mt-2 flex flex-col gap-1.5 text-xs" data-testid="history-rows">
      <li
        v-for="row in history"
        :key="row.assignmentId"
        class="flex items-center justify-between gap-2 rounded border border-line px-2 py-1.5"
        data-testid="history-row"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-1.5 font-medium text-ink">
            {{ row.loadRef }}
            <span
              v-if="row.late"
              class="rounded bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-200"
              data-testid="history-late-chip"
            >
              late{{ row.lateMinutes != null ? ` ${row.lateMinutes}m` : '' }}
            </span>
          </div>
          <div class="mt-0.5 truncate text-ink-3">
            {{ row.originCity ?? '—' }} → {{ row.destCity ?? '—' }}
            <span v-if="row.customerName"> · {{ row.customerName }}</span>
          </div>
        </div>
        <span class="shrink-0 text-ink-3">{{ completedLabel(row.completedAt) }}</span>
      </li>
    </ul>
    <p v-else class="mt-2 text-xs text-ink-3">No completed loads yet.</p>
  </section>
</template>

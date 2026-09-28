<script setup lang="ts">
import type { PresenterStageView } from '../../types/demo'

// Demo Mode (2026-09-28 plan, Task 2): the ten-stage rail across the top of
// /demo. Purely presentational — DemoView/stores/demo.ts already computed
// each tile's done/current/upcoming status; this only renders it.
defineProps<{ stages: PresenterStageView[] }>()
</script>

<template>
  <ol class="flex flex-wrap items-stretch gap-2" data-testid="stage-rail">
    <li
      v-for="stage in stages"
      :key="stage.id"
      class="flex min-w-[92px] flex-1 flex-col items-center gap-1 rounded-lg border px-2 py-2 text-center"
      :class="{
        'border-emerald-500/40 bg-emerald-500/10 text-emerald-600': stage.status === 'done',
        'border-brand bg-brand/10 text-brand-ink': stage.status === 'current',
        'border-line bg-surface text-ink-3': stage.status === 'upcoming',
      }"
      data-testid="stage-rail-item"
      :data-stage-id="stage.id"
      :data-status="stage.status"
    >
      <span class="text-base leading-none" aria-hidden="true">{{ stage.status === 'done' ? '✓' : '●' }}</span>
      <span class="text-[11px] font-semibold leading-tight">{{ stage.title }}</span>
    </li>
  </ol>
</template>

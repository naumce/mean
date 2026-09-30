<script setup lang="ts">
// AI Agents Surface (Task 4): the Dispatch Assistant's readiness card.
// Global Constraint: "Readiness is separate from functionality" — the
// headline/detail text (computed by stores/agents.ts's `dispatchStatus`)
// never implies drivers cannot be found without a model; this component is
// purely presentational.
defineProps<{ headline: string; detail: string }>()
</script>

<template>
  <div class="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
    <h2 class="text-sm font-semibold text-ink">Dispatch Assistant</h2>
    <p class="text-base font-semibold text-ink" data-testid="dispatch-headline">{{ headline }}</p>
    <p class="text-sm text-ink-2">{{ detail }}</p>
    <div class="mt-auto flex flex-wrap gap-4 pt-2 text-sm font-semibold text-brand-ink">
      <RouterLink to="/cockpit" class="hover:underline">Find a driver</RouterLink>
      <RouterLink to="/ai-lab" class="hover:underline">Advanced: AI Lab</RouterLink>
    </div>
  </div>
</template>

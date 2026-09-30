<script setup lang="ts">
// AI Agents Surface (Task 4): Night Shift's readiness/activity card. Global
// Constraint: "Mode is separate from activity" — the explainer line below
// says so explicitly; "Never imply an unenforced permission is enforced" —
// the enforcement notice below says so explicitly too. `headline`/`detail`
// come from stores/agents.ts's `nightShiftStatus`.
defineProps<{ headline: string; detail: string }>()
</script>

<template>
  <div class="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
    <h2 class="text-sm font-semibold text-ink">Night Shift</h2>
    <p class="text-base font-semibold text-ink" data-testid="nightshift-headline">{{ headline }}</p>
    <p class="text-sm text-ink-2">{{ detail }}</p>
    <p class="text-xs text-ink-3">Shadow/Live is what it may send. Watching/Waiting/Escalated is what it is doing.</p>
    <p class="rounded-md border border-line bg-surface-2 p-2 text-xs text-ink-2" data-testid="nightshift-enforcement">
      Customer email and quiet-hours settings are not enforced yet — communication is governed by Shadow/Live only.
    </p>
    <div class="mt-auto flex flex-wrap gap-4 pt-2 text-sm font-semibold text-brand-ink">
      <RouterLink to="/cockpit" class="hover:underline">Open Control Tower</RouterLink>
      <RouterLink to="/night-shift" class="hover:underline">Policies</RouterLink>
    </div>
  </div>
</template>

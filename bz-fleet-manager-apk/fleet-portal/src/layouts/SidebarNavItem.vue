<script setup lang="ts">
import { RouterLink } from 'vue-router'

withDefaults(
  defineProps<{
    label: string
    to?: string
    disabled?: boolean
  }>(),
  { to: undefined, disabled: false },
)
</script>

<template>
  <RouterLink
    v-if="!disabled && to"
    :to="to"
    class="flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-ink-2 hover:bg-brand/10 hover:text-brand-ink"
    active-class="bg-brand/10 text-brand-ink"
  >
    {{ label }}
  </RouterLink>
  <span
    v-else
    class="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-ink-3"
    :title="`${label} is coming in a later increment`"
  >
    {{ label }}
    <span class="ml-2 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
      Soon
    </span>
  </span>
</template>

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
    class="flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-primary-50 hover:text-primary-700"
    active-class="bg-primary-50 text-primary-700"
  >
    {{ label }}
  </RouterLink>
  <span
    v-else
    class="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-gray-400"
    :title="`${label} is coming in a later increment`"
  >
    {{ label }}
    <span class="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
      Soon
    </span>
  </span>
</template>

<script setup lang="ts">
defineProps<{
  id: string
  label: string
  error?: string | null
}>()
</script>

<template>
  <div class="flex flex-col gap-1">
    <label :for="id" class="text-sm font-medium text-ink-2">{{ label }}</label>
    <slot />
    <p v-if="error" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ error }}</p>
  </div>
</template>

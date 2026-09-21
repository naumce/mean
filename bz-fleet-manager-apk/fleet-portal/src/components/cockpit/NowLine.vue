<script setup lang="ts">
defineProps<{ x: number }>()
</script>

<template>
  <div class="ck-laser pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-red-500" :style="{ left: `${x}px` }" data-testid="now-line" />
</template>

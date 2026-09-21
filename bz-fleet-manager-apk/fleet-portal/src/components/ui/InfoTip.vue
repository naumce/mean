<script setup lang="ts">
// A small ⓘ that explains what a metric means, on hover or keyboard focus.
// CSS-only (group-hover/focus) — no portal, no JS positioning; the bubble
// hangs below-left so it never leaves the viewport on right-edge cards.
defineProps<{ text: string }>()
</script>

<template>
  <span class="group relative inline-flex" tabindex="0" data-testid="info-tip">
    <span
      aria-hidden="true"
      class="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-gray-200 text-[9px] font-bold text-gray-500 group-hover:bg-gray-300"
    >
      i
    </span>
    <span
      role="tooltip"
      class="pointer-events-none invisible absolute right-0 top-full z-20 mt-1 w-56 rounded-md bg-gray-900 px-2.5 py-1.5 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-white opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100"
    >
      {{ text }}
    </span>
  </span>
</template>

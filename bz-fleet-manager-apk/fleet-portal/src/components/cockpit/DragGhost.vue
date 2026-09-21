<script setup lang="ts">
// The translucent proposed brick. Rendered by GanttBoard as a sibling inside
// whichever lane's track currently holds the gesture, using the exact same
// `left/width` px convention as LegBrick — so `x`/`w` come straight from
// lib/cockpit/drag.ts + geometry.ts, never from raw pointer pixels. The real
// brick never moves; this is the only thing that follows the pointer, and it
// follows the *proposal* (snapped to grid), not the cursor itself.
withDefaults(
  defineProps<{
    x: number
    w: number
    label: string
    sub?: string
    /** True when the gesture would land somewhere the pipeline cannot accept
     *  (e.g. a lane with no resolvable driver) — shown, not silently hidden,
     *  so the dispatcher knows why nothing happens on release. */
    blocked?: boolean
  }>(),
  { sub: '', blocked: false },
)
</script>

<template>
  <div
    class="ck-ghost pointer-events-none absolute z-20 overflow-hidden rounded-lg border-2 border-dashed shadow-xl"
    :class="blocked ? 'border-conflict bg-conflict/15' : 'border-brand bg-brand/20'"
    :style="{ left: `${Math.round(x)}px`, width: `${Math.round(w)}px`, top: 'var(--brick-top)', height: 'var(--brick-h)' }"
    data-testid="drag-ghost"
  >
    <div class="truncate px-2 pt-1.5 text-[11px] font-mono font-bold" :class="blocked ? 'text-conflict' : 'text-brand-ink'">{{ label }}</div>
    <div v-if="sub" class="truncate px-2 text-[10px] text-ink-2">{{ sub }}</div>
  </div>
</template>

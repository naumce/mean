<script setup lang="ts">
import { computed } from 'vue'
import { fmtClock } from '../../lib/cockpit/format'
import { dayColumns, timeToX, totalWidth, type CockpitConfig } from '../../lib/cockpit/geometry'

const props = defineProps<{ cfg: CockpitConfig; nowMs: number }>()
const cols = computed(() => dayColumns(props.cfg, props.nowMs))
const width = computed(() => totalWidth(props.cfg))
const ticks = computed(() => {
  const out: Array<{ x: number; label: string | null; sep: boolean }> = []
  const every = props.cfg.pxPerHour > 40 ? 1 : 3
  for (let d = 0; d < props.cfg.days; d++)
    for (let h = props.cfg.dayStartHour; h < props.cfg.dayEndHour; h++) {
      const x = d * (props.cfg.dayEndHour - props.cfg.dayStartHour) * props.cfg.pxPerHour + (h - props.cfg.dayStartHour) * props.cfg.pxPerHour
      out.push({ x, label: h % every === 0 ? `${String(h).padStart(2, '0')}:00` : null, sep: h === props.cfg.dayStartHour && d > 0 })
    }
  return out
})
const nowX = computed(() => timeToX(props.nowMs, props.cfg))
</script>

<template>
  <div class="relative h-11 shrink-0 select-none" :style="{ width: `${width}px` }" data-testid="ruler">
    <div
      v-for="c in cols"
      :key="c.ymd"
      class="absolute top-0 h-[22px] overflow-hidden whitespace-nowrap border-l border-line-strong px-2 pt-1 font-mono text-[11px] font-bold"
      :class="c.isToday ? 'bg-brand/5 text-brand-ink' : c.isWeekend ? 'text-ink-3' : 'text-ink-2'"
      :style="{ left: `${c.x}px`, width: `${c.width}px` }"
    >
      {{ c.label }}{{ c.isToday ? ' (TODAY)' : c.isWeekend ? ' (WEEKEND)' : '' }}
      <span v-if="c.isToday" class="ml-2 rounded bg-brand/20 px-1.5 py-0.5 text-[9px] text-brand-ink">NOW: {{ fmtClock(nowMs, cfg.tz) }}</span>
    </div>
    <div v-for="t in ticks" :key="t.x" class="absolute bottom-0 top-[22px] border-l" :class="t.sep ? 'border-line-strong' : 'border-line/60'" :style="{ left: `${t.x}px` }">
      <span v-if="t.label" class="absolute bottom-1 left-1 font-mono text-[9px] text-ink-3">{{ t.label }}</span>
    </div>
    <div v-if="nowX !== null" class="absolute top-6 z-30 -translate-x-1/2 rounded bg-red-500 px-1.5 font-mono text-[8px] font-bold text-white" :style="{ left: `${nowX}px` }">NOW {{ fmtClock(nowMs, cfg.tz) }}</div>
  </div>
</template>

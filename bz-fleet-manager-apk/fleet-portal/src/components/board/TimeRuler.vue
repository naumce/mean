<script setup lang="ts">
import { computed } from 'vue'
import type { BoardConfig } from '../../lib/board/geometry'
import { hourWidth } from '../../lib/board/geometry'

const props = defineProps<{ config: BoardConfig }>()

function utcDayIndex(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  return Math.round((b - a) / 86400000) + 1
}

const hours = computed(() => {
  const out: { label: string; left: number }[] = []
  const w = hourWidth(props.config)
  const perDay = props.config.dayEndHour - props.config.dayStartHour
  const days = utcDayIndex(props.config.fromDate, props.config.toDate)
  for (let d = 0; d < days; d++) {
    for (let h = props.config.dayStartHour; h < props.config.dayEndHour; h++) {
      out.push({
        label: `${String(h).padStart(2, '0')}:00`,
        left: Math.round((d * perDay + (h - props.config.dayStartHour)) * w),
      })
    }
  }
  return out
})

// Day chips only appear on multi-day windows; a single day is labeled by the
// window controls above the board.
const dayMarks = computed(() => {
  const days = utcDayIndex(props.config.fromDate, props.config.toDate)
  if (days <= 1) return []
  const w = hourWidth(props.config)
  const perDay = props.config.dayEndHour - props.config.dayStartHour
  const from = Date.UTC(
    props.config.fromDate.getUTCFullYear(),
    props.config.fromDate.getUTCMonth(),
    props.config.fromDate.getUTCDate(),
  )
  return Array.from({ length: days }, (_, d) => ({
    label: new Date(from + d * 86400000).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    }),
    left: Math.round(d * perDay * w),
  }))
})
</script>

<template>
  <div class="flex border-b border-gray-300 bg-gray-50">
    <div class="w-40 shrink-0 border-r border-gray-200" />
    <div
      class="relative shrink-0"
      :class="dayMarks.length ? 'h-12' : 'h-8'"
      :style="{ width: `${config.boardWidthPx}px` }"
    >
      <span
        v-for="day in dayMarks"
        :key="`day-${day.left}`"
        data-testid="day-mark"
        class="absolute top-0.5 border-l border-gray-300 pl-1 text-[10px] font-semibold text-gray-600"
        :style="{ left: `${day.left}px` }"
      >
        {{ day.label }}
      </span>
      <span
        v-for="hr in hours"
        :key="hr.left"
        class="absolute text-[10px] text-gray-400"
        :class="dayMarks.length ? 'top-5' : 'top-1'"
        :style="{ left: `${hr.left}px` }"
      >
        {{ hr.label }}
      </span>
    </div>
  </div>
</template>

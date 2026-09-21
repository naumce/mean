<script setup lang="ts">
import { computed } from 'vue'
import type { DeadheadConnector } from '../../lib/cockpit/deadhead'

const props = defineProps<{ conn: DeadheadConnector; centsPerMi: number | null }>()
const label = computed(() => {
  const mi = props.conn.miles != null ? `DH ~${props.conn.miles} mi` : 'DH ? mi'
  const cost = props.conn.miles != null && props.centsPerMi != null ? ` · -$${Math.round((props.conn.miles * props.centsPerMi) / 100)}` : ''
  return `${mi}${cost} · ${props.conn.fromCity} → ${props.conn.toCity}`
})
</script>

<template>
  <div class="ck-dh absolute z-[3] h-[2px]" :style="{ left: `${conn.x1}px`, width: `${conn.x2 - conn.x1}px`, top: 'calc(var(--brick-top) + var(--brick-h) / 2)' }" :data-dh="conn.toLoadId">
    <span class="absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-bg/85 px-1 font-mono text-[9px] text-ink-3" :style="{ top: 'calc(-1 * (var(--brick-top) + var(--brick-h) / 2) + 2px)' }">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatMiles, formatPct, formatUsd } from '../lib/money'
import { useAnalyticsStore } from '../stores/analytics'

// Which freight relationships actually make money: committed revenue, margin,
// $/loaded mile, and deadhead share per broker/customer, best margin first —
// plus the driver-settlements rollup (completed work in a date range).
const analytics = useAnalyticsStore()

// Settlement range inputs (yyyy-mm-dd). Empty = the server's trailing week.
const settleFrom = ref('')
const settleTo = ref('')

function applySettlementRange(): void {
  const range: { from?: string; to?: string } = {}
  if (settleFrom.value) range.from = `${settleFrom.value}T00:00:00.000Z`
  // Inclusive end date: send the following midnight (the API range is [from, to)).
  if (settleTo.value) range.to = new Date(Date.parse(`${settleTo.value}T00:00:00.000Z`) + 86_400_000).toISOString()
  analytics.loadSettlements(range)
}

function rangeLabel(iso: string): string {
  return iso.slice(0, 10)
}

// The scoreboard: rank drivers by what they PROFIT the fleet (default) or by
// raw revenue hauled. Medals for the podium — dispatch is competitive.
const scoreBy = ref<'marginCents' | 'revenueCents'>('marginCents')
const rankedSettlements = computed(() =>
  [...analytics.settlements].sort((a, b) => b[scoreBy.value] - a[scoreBy.value]),
)
const MEDALS = ['🥇', '🥈', '🥉']

onMounted(() => {
  analytics.loadBrokers()
  analytics.loadLanes()
  analytics.loadSettlements()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-gray-900">Analytics</h1>
      <p class="text-sm text-gray-500">
        Committed loads only — who you haul for, what it earns, and the lanes you keep running.
      </p>
    </div>

    <p v-if="analytics.error" class="text-sm text-red-600" role="alert">{{ analytics.error }}</p>

    <p
      v-if="!analytics.loading && !analytics.error && analytics.brokers.length === 0"
      class="text-sm text-gray-500"
      data-testid="brokers-empty"
    >
      No committed loads yet — dispatch a few loads and the rollup appears here.
    </p>

    <div v-if="analytics.brokers.length" class="overflow-x-auto rounded-lg border border-gray-200">
      <div class="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700">
        <span>Broker profitability</span>
        <button
          type="button"
          class="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
          data-testid="brokers-export"
          @click="analytics.exportCsv('brokers')"
        >
          Export CSV
        </button>
      </div>
      <table class="w-full text-left text-sm" data-testid="brokers-table">
        <thead class="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th class="px-4 py-2 font-medium" title="Who tendered the freight — best total margin first">Broker / customer</th>
            <th class="px-4 py-2 font-medium" title="Committed loads from this relationship">Loads</th>
            <th class="px-4 py-2 font-medium" title="Linehaul + fuel surcharge across those loads">Revenue</th>
            <th class="px-4 py-2 font-medium" title="Revenue minus estimated running cost, with the share of revenue kept">Margin</th>
            <th class="px-4 py-2 font-medium" title="Revenue per loaded mile — is this customer's freight priced right?">$ / loaded mi</th>
            <th class="px-4 py-2 font-medium" title="Empty miles their freight forces you to drive, and the share of total miles">Deadhead</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="b in analytics.brokers" :key="b.broker" :data-broker="b.broker">
            <td class="px-4 py-2 font-medium text-gray-900">{{ b.broker }}</td>
            <td class="px-4 py-2 text-gray-700">{{ b.loads }}</td>
            <td class="px-4 py-2 text-gray-700">{{ formatUsd(b.revenueCents) }}</td>
            <td class="px-4 py-2 font-semibold" :class="b.marginCents >= 0 ? 'text-emerald-600' : 'text-red-600'">
              {{ formatUsd(b.marginCents) }}
              <span class="font-normal text-gray-500">({{ formatPct(b.avgMarginPct) }})</span>
            </td>
            <td class="px-4 py-2 text-gray-700">{{ (b.ratePerLoadedMiCents / 100).toFixed(2) }}</td>
            <td class="px-4 py-2 text-gray-700">
              {{ formatMiles(b.deadheadMi) }}
              <span class="text-gray-500">({{ formatPct(b.deadheadPct) }})</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="analytics.lanes.length" class="overflow-x-auto rounded-lg border border-gray-200">
      <div class="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700">
        <span>Recurring lanes</span>
        <button
          type="button"
          class="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
          data-testid="lanes-export"
          @click="analytics.exportCsv('lanes')"
        >
          Export CSV
        </button>
      </div>
      <table class="w-full text-left text-sm" data-testid="lanes-table">
        <thead class="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th class="px-4 py-2 font-medium">Lane</th>
            <th class="px-4 py-2 font-medium">Runs</th>
            <th class="px-4 py-2 font-medium">Revenue</th>
            <th class="px-4 py-2 font-medium">Margin</th>
            <th class="px-4 py-2 font-medium">Top driver</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="lane in analytics.lanes" :key="lane.lane" :data-lane-row="lane.lane">
            <td class="px-4 py-2 font-medium text-gray-900">{{ lane.origin }} → {{ lane.destination }}</td>
            <td class="px-4 py-2 text-gray-700">{{ lane.runs }}</td>
            <td class="px-4 py-2 text-gray-700">{{ formatUsd(lane.revenueCents) }}</td>
            <td class="px-4 py-2 font-semibold" :class="lane.marginCents >= 0 ? 'text-emerald-600' : 'text-red-600'">
              {{ formatUsd(lane.marginCents) }}
            </td>
            <td class="px-4 py-2 text-gray-700">{{ lane.topDriver ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="overflow-x-auto rounded-lg border border-gray-200" data-testid="settlements-card">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700">
        <span>
          Driver scoreboard &amp; settlements
          <span v-if="analytics.settlementRange" class="font-normal text-gray-500">
            ({{ rangeLabel(analytics.settlementRange.from) }} → {{ rangeLabel(analytics.settlementRange.to) }},
            completed loads only)
          </span>
        </span>
        <span class="flex overflow-hidden rounded border border-gray-300 text-xs">
          <button
            type="button"
            class="px-2 py-0.5"
            :class="scoreBy === 'marginCents' ? 'bg-primary-600 font-semibold text-white' : 'bg-white text-gray-600 hover:bg-gray-100'"
            data-testid="score-by-profit"
            title="Rank by what each driver PROFITS the fleet (revenue minus estimated running cost)"
            @click="scoreBy = 'marginCents'"
          >
            By profit
          </button>
          <button
            type="button"
            class="border-l border-gray-300 px-2 py-0.5"
            :class="scoreBy === 'revenueCents' ? 'bg-primary-600 font-semibold text-white' : 'bg-white text-gray-600 hover:bg-gray-100'"
            data-testid="score-by-revenue"
            title="Rank by raw revenue hauled"
            @click="scoreBy = 'revenueCents'"
          >
            By revenue
          </button>
        </span>
        <span class="flex items-center gap-2">
          <input
            v-model="settleFrom"
            type="date"
            class="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-700"
            data-testid="settle-from"
          />
          <span class="text-xs text-gray-400">→</span>
          <input
            v-model="settleTo"
            type="date"
            class="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-700"
            data-testid="settle-to"
          />
          <button
            type="button"
            class="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
            data-testid="settle-apply"
            @click="applySettlementRange"
          >
            Apply
          </button>
          <button
            v-if="analytics.settlements.length"
            type="button"
            class="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
            data-testid="settlements-export"
            @click="analytics.exportCsv('settlements')"
          >
            Export CSV
          </button>
        </span>
      </div>
      <p v-if="!analytics.settlements.length" class="px-4 py-3 text-sm text-gray-500" data-testid="settlements-empty">
        No completed loads in this range — deliver a few and the payroll view fills in.
      </p>
      <table v-else class="w-full text-left text-sm" data-testid="settlements-table">
        <thead class="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th class="px-4 py-2 font-medium" title="Podium ranked by the toggle above">#</th>
            <th class="px-4 py-2 font-medium" title="Ranked by the toggle above">Driver</th>
            <th class="px-4 py-2 font-medium" title="Loads delivered in this range">Loads</th>
            <th class="px-4 py-2 font-medium" title="Total miles driven, with the empty (dh = deadhead) share">Miles</th>
            <th class="px-4 py-2 font-medium" title="Revenue of the loads this driver delivered">Revenue</th>
            <th class="px-4 py-2 font-medium" title="What those loads earned after estimated running cost">Margin</th>
            <th
              class="px-4 py-2 font-medium"
              title="Total miles × that driver's own carrier pay rate — a planning estimate, not payroll. Carriers on different rates are priced separately, so the rate is shown per row rather than once in this header."
            >
              Est. pay
            </th>
            <th class="px-4 py-2 font-medium" title="Revenue per loaded mile for this driver's freight">$ / loaded mi</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="(d, i) in rankedSettlements" :key="d.driverId" :data-settlement-row="d.driverName" :data-rank="i + 1">
            <td class="px-4 py-2 text-gray-700">{{ MEDALS[i] ?? i + 1 }}</td>
            <td class="px-4 py-2 font-medium text-gray-900">{{ d.driverName }}</td>
            <td class="px-4 py-2 text-gray-700">{{ d.loads }}</td>
            <td class="px-4 py-2 text-gray-700">
              {{ formatMiles(d.totalMi) }}
              <span v-if="d.deadheadMi > 0" class="text-gray-500">({{ formatMiles(d.deadheadMi) }} dh)</span>
            </td>
            <td class="px-4 py-2 text-gray-700">{{ formatUsd(d.revenueCents) }}</td>
            <td class="px-4 py-2 font-semibold" :class="d.marginCents >= 0 ? 'text-emerald-600' : 'text-red-600'">
              {{ formatUsd(d.marginCents) }}
            </td>
            <td class="px-4 py-2 text-gray-700">
              {{ formatUsd(d.estPayCents) }}
              <span v-if="d.driverPayCentsPerMi != null" class="text-xs text-gray-400">
                @ ${{ (d.driverPayCentsPerMi / 100).toFixed(2) }}/mi
              </span>
            </td>
            <td class="px-4 py-2 text-gray-700">{{ (d.rpmLoadedCents / 100).toFixed(2) }}</td>
          </tr>
          <tr v-if="analytics.settlementTotals" class="bg-gray-50 font-semibold" data-testid="settlements-total">
            <td class="px-4 py-2"></td>
            <td class="px-4 py-2 text-gray-900">Total</td>
            <td class="px-4 py-2 text-gray-700">{{ analytics.settlementTotals.loads }}</td>
            <td class="px-4 py-2 text-gray-700">{{ formatMiles(analytics.settlementTotals.totalMi) }}</td>
            <td class="px-4 py-2 text-gray-700">{{ formatUsd(analytics.settlementTotals.revenueCents) }}</td>
            <td class="px-4 py-2" :class="analytics.settlementTotals.marginCents >= 0 ? 'text-emerald-600' : 'text-red-600'">
              {{ formatUsd(analytics.settlementTotals.marginCents) }}
            </td>
            <td class="px-4 py-2 text-gray-700">{{ formatUsd(analytics.settlementTotals.estPayCents) }}</td>
            <td class="px-4 py-2"></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

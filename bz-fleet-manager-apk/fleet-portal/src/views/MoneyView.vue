<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import CarrierStatements from '../components/money/CarrierStatements.vue'
import InfoTip from '../components/ui/InfoTip.vue'
import { formatMiles, formatPct, formatUsd } from '../lib/money'
import { useEconomicsStore } from '../stores/economics'

// The Money screen: what each committed load actually earns, priced with the
// org's own cost model. Worst margin first — the money-losers are the rows a
// dispatcher needs to see, not the wins.
const economics = useEconomicsStore()

// Cost-model edits happen in display units (dollars / raw mpg); cents only on
// the wire. Never mutate the store's copy — save() sends a fresh payload.
const edit = reactive({ mpg: 6.5, dieselPerGal: 4, driverPayPerMi: 0.6, fixedPerMi: 0.45 })

// Dispatch-date window (yyyy-mm-dd). Empty = everything committed.
const rangeFrom = ref('')
const rangeTo = ref('')

function applyRange(): void {
  const range: { from?: string; to?: string } = {}
  if (rangeFrom.value) range.from = `${rangeFrom.value}T00:00:00.000Z`
  // Inclusive end date: the API range is [from, to), so send the next midnight.
  if (rangeTo.value) range.to = new Date(Date.parse(`${rangeTo.value}T00:00:00.000Z`) + 86_400_000).toISOString()
  economics.loadEconomics(Object.keys(range).length ? range : undefined)
}

watch(
  () => economics.costModel,
  (model) => {
    if (!model) return
    edit.mpg = model.mpg
    edit.dieselPerGal = model.dieselCentsPerGal / 100
    edit.driverPayPerMi = model.driverPayCentsPerMi / 100
    edit.fixedPerMi = model.fixedCentsPerMi / 100
  },
  { immediate: true },
)

function saveCostModel(): void {
  economics.saveCostModel({
    mpg: edit.mpg,
    dieselCentsPerGal: Math.round(edit.dieselPerGal * 100),
    driverPayCentsPerMi: Math.round(edit.driverPayPerMi * 100),
    fixedCentsPerMi: Math.round(edit.fixedPerMi * 100),
  })
}

function marginClass(marginCents: number, marginPct: number): string {
  if (marginCents < 0) return 'text-red-600'
  if (marginPct < 0.1) return 'text-amber-600'
  return 'text-emerald-600'
}

function perMile(cents: number): string {
  return (cents / 100).toFixed(2)
}

const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned',
  in_progress: 'Rolling',
  delivered: 'Delivered',
}

onMounted(() => {
  economics.loadEconomics()
  economics.loadCostModel()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-gray-900">Money</h1>
        <p class="text-sm text-gray-500">
          Committed loads priced with your own cost model — worst margin first, so the losers surface.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="rangeFrom"
          type="date"
          class="rounded border border-gray-300 px-1.5 py-1 text-xs text-gray-700"
          data-testid="money-from"
        />
        <span class="text-xs text-gray-400">→</span>
        <input
          v-model="rangeTo"
          type="date"
          class="rounded border border-gray-300 px-1.5 py-1 text-xs text-gray-700"
          data-testid="money-to"
        />
        <button
          type="button"
          class="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
          data-testid="money-apply"
          @click="applyRange"
        >
          Apply
        </button>
        <button
          v-if="economics.rows.length"
          type="button"
          class="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          data-testid="money-export"
          @click="economics.exportCsv()"
        >
          Export CSV
        </button>
      </div>
    </div>

    <p v-if="economics.error" class="text-sm text-red-600" role="alert">{{ economics.error }}</p>

    <div
      v-if="economics.totals && economics.totals.loads > 0"
      class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      data-testid="money-summary"
    >
      <div class="rounded-lg border border-gray-200 bg-white p-3">
        <p class="flex items-center justify-between text-xs uppercase tracking-wide text-gray-500">
          Revenue <InfoTip text="Linehaul + fuel surcharge of every committed load in the current range." />
        </p>
        <p class="text-lg font-semibold text-gray-900">{{ formatUsd(economics.totals.revenueCents) }}</p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-3">
        <p class="flex items-center justify-between text-xs uppercase tracking-wide text-gray-500">
          Est. cost <InfoTip text="Miles driven × your cost model below (fuel at your MPG, driver pay, fixed overhead) — snapshotted when each load was dispatched." />
        </p>
        <p class="text-lg font-semibold text-gray-900">{{ formatUsd(economics.totals.estCostCents) }}</p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-3">
        <p class="flex items-center justify-between text-xs uppercase tracking-wide text-gray-500">
          Margin <InfoTip text="Revenue minus estimated cost. Red = losing money, amber = under 10% of revenue, green = healthy." />
        </p>
        <p class="text-lg font-semibold" :class="marginClass(economics.totals.marginCents, economics.totals.marginPct)">
          {{ formatUsd(economics.totals.marginCents) }}
          <span class="text-sm font-normal text-gray-500">({{ formatPct(economics.totals.marginPct) }})</span>
        </p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-3">
        <p class="flex items-center justify-between text-xs uppercase tracking-wide text-gray-500">
          $ / loaded mi <InfoTip text="Revenue per loaded mile (RPM) — the industry yardstick for whether freight pays enough." />
        </p>
        <p class="text-lg font-semibold text-gray-900">{{ perMile(economics.totals.rpmLoadedCents) }}</p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-3">
        <p class="flex items-center justify-between text-xs uppercase tracking-wide text-gray-500">
          Deadhead share <InfoTip text="Share of all miles driven empty (no freight) to reach pickups. Lower is better — these miles cost fuel and hours but earn nothing." />
        </p>
        <p class="text-lg font-semibold text-gray-900">
          {{ formatPct(economics.totals.deadheadPct) }}
          <span class="text-sm font-normal text-gray-500">({{ formatMiles(economics.totals.deadheadMi) }})</span>
        </p>
      </div>
    </div>

    <CarrierStatements :from="rangeFrom" :to="rangeTo" />

    <div class="rounded-lg border border-gray-200 bg-white p-4" data-testid="cost-model">
      <div class="flex items-baseline justify-between">
        <h2 class="text-sm font-semibold text-gray-900">Your cost model</h2>
        <p v-if="economics.costModel" class="text-sm text-gray-600">
          All-in <span class="font-semibold text-gray-900">${{ perMile(economics.costModel.allInCentsPerMi) }}/mi</span>
        </p>
      </div>
      <p class="mt-1 text-xs text-gray-500">
        Prices every new dispatch. Already-committed loads keep the price they were dispatched at.
      </p>
      <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label class="text-xs text-gray-600">
          Truck MPG
          <input
            v-model.number="edit.mpg"
            type="number" step="0.1" min="3" max="12"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
            data-testid="cost-mpg"
          />
        </label>
        <label class="text-xs text-gray-600">
          Diesel $ / gal
          <input
            v-model.number="edit.dieselPerGal"
            type="number" step="0.01" min="1" max="12"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
            data-testid="cost-diesel"
          />
        </label>
        <label class="text-xs text-gray-600">
          Driver pay $ / mi
          <input
            v-model.number="edit.driverPayPerMi"
            type="number" step="0.01" min="0" max="3"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
            data-testid="cost-driver-pay"
          />
        </label>
        <label class="text-xs text-gray-600">
          Fixed $ / mi
          <input
            v-model.number="edit.fixedPerMi"
            type="number" step="0.01" min="0" max="3"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
            data-testid="cost-fixed"
          />
        </label>
      </div>
      <div class="mt-3 flex items-center gap-3">
        <button
          type="button"
          class="rounded bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          :disabled="economics.saving"
          data-testid="cost-save"
          @click="saveCostModel"
        >
          {{ economics.saving ? 'Saving…' : 'Save cost model' }}
        </button>
        <span v-if="economics.saved" class="text-sm text-emerald-600" data-testid="cost-saved">
          Saved — applies to new dispatches
        </span>
      </div>
    </div>

    <p
      v-if="!economics.loading && !economics.error && economics.rows.length === 0"
      class="text-sm text-gray-500"
      data-testid="money-empty"
    >
      No committed loads yet — dispatch a few loads and their margins appear here.
    </p>

    <div v-if="economics.rows.length" class="overflow-x-auto rounded-lg border border-gray-200">
      <table class="w-full text-left text-sm" data-testid="money-table">
        <thead class="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th class="px-4 py-2 font-medium">Load</th>
            <th class="px-4 py-2 font-medium">Broker</th>
            <th class="px-4 py-2 font-medium">Driver</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2 font-medium" title="Linehaul + fuel surcharge">Revenue</th>
            <th class="px-4 py-2 font-medium" title="Loaded miles, plus the empty drive to the pickup (dh = deadhead)">Miles</th>
            <th class="px-4 py-2 font-medium" title="Revenue per loaded mile — the rate yardstick">$ / loaded mi</th>
            <th class="px-4 py-2 font-medium" title="Miles × your cost model, priced when the load was dispatched">Est. cost</th>
            <th class="px-4 py-2 font-medium" title="Revenue minus est. cost — red is losing money, amber under 10%">Margin</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="row in economics.rows" :key="row.loadId" :data-money-row="row.ref">
            <td class="px-4 py-2 font-medium text-gray-900">{{ row.ref }}</td>
            <td class="px-4 py-2 text-gray-700">{{ row.broker ?? '—' }}</td>
            <td class="px-4 py-2 text-gray-700">{{ row.driverName ?? '—' }}</td>
            <td class="px-4 py-2 text-gray-700">{{ STATUS_LABEL[row.status] ?? row.status }}</td>
            <td class="px-4 py-2 text-gray-700">{{ formatUsd(row.revenueCents) }}</td>
            <td class="px-4 py-2 text-gray-700">
              {{ formatMiles(row.loadedMi) }}
              <span v-if="row.deadheadMi > 0" class="text-gray-500">+ {{ formatMiles(row.deadheadMi) }} dh</span>
            </td>
            <td class="px-4 py-2 text-gray-700">{{ perMile(row.rpmLoadedCents) }}</td>
            <td class="px-4 py-2 text-gray-700">{{ formatUsd(row.estCostCents) }}</td>
            <td class="px-4 py-2 font-semibold" :class="marginClass(row.marginCents, row.marginPct)">
              {{ formatUsd(row.marginCents) }}
              <span class="font-normal text-gray-500">({{ formatPct(row.marginPct) }})</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

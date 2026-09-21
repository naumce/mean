<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { fetchCarrierStatements, type CarrierStatementsResult } from '../../lib/api'
import { formatUsd } from '../../lib/money'

// What this dispatch service INVOICES each client carrier for the period — the
// other side of the ledger from driver settlements, which compute what a
// carrier pays its driver. Until this existed the product could dispatch trucks
// it did not own and never bill anyone for doing it.
//
// Three states this must keep apart, because collapsing any two of them puts a
// wrong number on a real invoice:
//   · terms agreed, everything billable      -> a total you can send
//   · terms agreed, some loads not billable  -> a total that is INCOMPLETE
//   · no terms agreed                        -> nothing to bill, NOT $0
// And own-fleet work is reported separately: there is nobody to invoice for it,
// which is a different fact from a carrier owing zero.

const props = defineProps<{ from: string; to: string }>()

const data = ref<CarrierStatementsResult | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

/** MoneyView's pickers hold date-only strings and start EMPTY. Rather than
 *  render a blank panel until someone picks a range, default to the last seven
 *  days — the period a dispatch service actually invoices on — and accept
 *  either a date-only or a full ISO value from the parent. */
function isoRange(): { from: string; to: string } {
  const toIso = (v: string, endOfDay: boolean): string | null => {
    if (!v) return null
    if (v.includes('T')) return v
    return `${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
  }
  const to = toIso(props.to, true) ?? new Date().toISOString()
  const from = toIso(props.from, false) ?? new Date(Date.now() - 7 * 86_400_000).toISOString()
  return { from, to }
}

async function load(): Promise<void> {
  const { from, to } = isoRange()
  loading.value = true
  error.value = null
  try {
    data.value = await fetchCarrierStatements(from, to)
  } catch {
    // Leave the previous statement on screen. A failed refresh is not an empty
    // invoice run, and blanking the table would read as "nothing owed".
    error.value = 'Could not load carrier statements'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [props.from, props.to], load)

const grandTotalCents = computed(() =>
  (data.value?.rows ?? []).reduce((a, r) => a + r.statement.totalCents, 0),
)

const termsLabel = (r: NonNullable<CarrierStatementsResult['rows']>[number]): string => {
  const t = r.terms
  if (!t.model) return 'No terms agreed'
  if (t.model === 'percent_linehaul') return `${((t.pctBps ?? 0) / 100).toFixed(2)}% of linehaul`
  if (t.model === 'per_load') return `${formatUsd(t.flatCents ?? 0)} per load`
  return `${formatUsd(t.flatCents ?? 0)} per truck / week`
}
</script>

<template>
  <div class="rounded-lg border border-gray-200 bg-white p-4" data-testid="carrier-statements">
    <div class="flex items-baseline justify-between">
      <h2 class="text-sm font-semibold text-gray-900">Carrier statements</h2>
      <span class="font-mono text-xs text-gray-500">what you invoice, this period</span>
    </div>

    <div v-if="loading && !data" class="py-6 text-center text-xs text-gray-500" data-testid="statements-loading">
      Building statements…
    </div>

    <!-- An outage must never render as "nothing owed". -->
    <div v-else-if="error && !data" class="py-6 text-center text-xs text-amber-600" data-testid="statements-error">
      {{ error }}
    </div>

    <template v-else-if="data">
      <div v-if="error" class="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700" data-testid="statements-stale">
        {{ error }} — showing the last figures loaded.
      </div>

      <table class="mt-3 w-full text-left text-xs">
        <thead class="text-[10px] uppercase tracking-wide text-gray-500">
          <tr>
            <th class="pb-2 pr-2">Carrier</th>
            <th class="pb-2 pr-2">Terms</th>
            <th class="pb-2 pr-2 text-right">Loads</th>
            <th class="pb-2 pr-2 text-right">Basis</th>
            <th class="pb-2 text-right">Due</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in data.rows"
            :key="r.carrierId"
            class="border-t border-gray-100"
            :data-statement-row="r.carrierId"
          >
            <td class="py-2 pr-2 font-semibold text-gray-900">{{ r.carrierName }}</td>
            <td class="py-2 pr-2" :class="r.terms.model ? 'text-gray-600' : 'text-amber-600'">
              {{ termsLabel(r) }}
            </td>
            <td class="py-2 pr-2 text-right font-mono text-gray-600">
              {{ r.statement.billedLoadCount }}
              <span v-if="r.terms.model === 'per_truck_week'" class="text-gray-400">
                · {{ r.truckWeeks }} tw
              </span>
            </td>
            <td class="py-2 pr-2 text-right font-mono text-gray-600">
              <template v-if="r.statement.basisCents">{{ formatUsd(r.statement.basisCents) }}</template>
              <span v-else class="text-gray-400">—</span>
            </td>
            <td class="py-2 text-right font-mono font-bold" :class="r.terms.model ? 'text-emerald-700' : 'text-gray-400'">
              <!-- No terms means NOTHING TO BILL, which is not $0 owed. -->
              <template v-if="r.terms.model">{{ formatUsd(r.statement.totalCents) }}</template>
              <span v-else data-testid="statement-no-terms">not billable</span>
              <span
                v-if="r.terms.model && !r.statement.complete"
                class="ml-1 text-amber-600"
                :title="r.statement.unbillable.map((u) => u.reason).join('; ')"
                data-testid="statement-incomplete"
              >⚠</span>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Reasons, verbatim from the server. A statement that is short by three
           loads has to say which and why, or the total looks like the whole. -->
      <div
        v-for="r in data.rows.filter((x) => x.terms.model && !x.statement.complete)"
        :key="`u-${r.carrierId}`"
        class="mt-2 rounded bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800"
        data-testid="statement-unbillable"
      >
        <span class="font-semibold">{{ r.carrierName }}:</span>
        {{ r.statement.unbillable.length }} load(s) not billed —
        {{ [...new Set(r.statement.unbillable.map((u) => u.reason))].join('; ') }}
      </div>

      <div class="mt-3 flex items-baseline justify-between border-t border-gray-200 pt-2">
        <span class="text-xs font-semibold text-gray-900">Total invoiceable</span>
        <span class="font-mono text-sm font-bold text-emerald-700" data-testid="statements-total">
          {{ formatUsd(grandTotalCents) }}
        </span>
      </div>

      <!-- Own trucks: there is nobody to invoice, so this is never folded into
           the total above. -->
      <div v-if="data.ownFleet.loadCount" class="mt-2 text-[11px] text-gray-500" data-testid="statements-own-fleet">
        Plus {{ data.ownFleet.loadCount }} load(s) on your own trucks
        ({{ formatUsd(data.ownFleet.linehaulCents) }} linehaul) — no carrier to invoice.
      </div>
    </template>
  </div>
</template>

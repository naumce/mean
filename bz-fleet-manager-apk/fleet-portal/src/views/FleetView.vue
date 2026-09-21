<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import FleetMap from '../components/tracking/FleetMap.vue'
import InfoTip from '../components/ui/InfoTip.vue'
import { complianceStatus } from '../lib/compliance'
import { haversineMi } from '../lib/geo'
import { useFleetStore } from '../stores/fleet'
import type { FleetTractor, FleetTrailer } from '../stores/fleet'

// Fleet compliance & maintenance: every unit's inspection/registration/
// service clocks (the same ones the dispatch engine checks), the service-shop
// registry on the map, the log-a-service flow, and the maintenance ledger.
const fleet = useFleetStore()

const CHIP: Record<string, string> = {
  expired: 'bg-red-100 text-red-700 font-semibold',
  soon: 'bg-amber-100 text-amber-800',
  ok: 'bg-emerald-50 text-emerald-700',
  untracked: 'bg-gray-100 text-gray-500',
}

function chip(iso: string | null) {
  return complianceStatus(iso, Date.now())
}

// ── Log-a-service form (opens per unit) ────────────────────────────────────
const serviceUnit = ref<{ kind: 'tractor' | 'trailer'; id: string; label: string; lat: number | null; lng: number | null } | null>(null)
const serviceForm = reactive({ shopId: '', kind: 'service', performedAt: '', nextDueAt: '', notes: '' })
const serviceSaved = ref(false)

// Shops for the picker, nearest first when the unit's position is known —
// "pick another service" with the distance right in the option label.
const shopOptions = computed(() => {
  const unit = serviceUnit.value
  const options = fleet.shops.map((s) => {
    const mi =
      unit?.lat != null && unit.lng != null && s.lat != null && s.lng != null
        ? Math.round(haversineMi(unit.lat, unit.lng, s.lat, s.lng))
        : null
    return { id: s.id, label: mi != null ? `${s.name} (${mi} mi away)` : s.name, mi }
  })
  return [...options].sort((a, b) => (a.mi ?? Number.MAX_SAFE_INTEGER) - (b.mi ?? Number.MAX_SAFE_INTEGER))
})

function openService(kind: 'tractor' | 'trailer', unit: FleetTractor | FleetTrailer): void {
  serviceUnit.value = {
    kind, id: unit.id, lat: unit.lastLat, lng: unit.lastLng,
    label: `${kind === 'tractor' ? 'Tractor #' : 'Trailer '}${unit.unit}`,
  }
  serviceForm.shopId = shopOptions.value[0]?.id ?? ''
  serviceForm.kind = 'service'
  serviceForm.performedAt = new Date().toISOString().slice(0, 10)
  serviceForm.nextDueAt = ''
  serviceForm.notes = ''
  serviceSaved.value = false
}

async function submitService(): Promise<void> {
  if (!serviceUnit.value || !serviceForm.shopId) return
  const ok = await fleet.logService({
    shopId: serviceForm.shopId,
    ...(serviceUnit.value.kind === 'tractor' ? { tractorId: serviceUnit.value.id } : { trailerId: serviceUnit.value.id }),
    kind: serviceForm.kind as 'inspection' | 'registration' | 'service' | 'repair',
    ...(serviceForm.performedAt ? { performedAt: `${serviceForm.performedAt}T12:00:00.000Z` } : {}),
    ...(serviceForm.nextDueAt ? { nextDueAt: `${serviceForm.nextDueAt}T12:00:00.000Z` } : {}),
    ...(serviceForm.notes ? { notes: serviceForm.notes } : {}),
  })
  if (ok) {
    serviceSaved.value = true
    serviceUnit.value = null
  }
}

// ── Register-a-shop form ───────────────────────────────────────────────────
const shopForm = reactive({ name: '', address: '', phone: '' })
const addingShop = ref(false)

async function submitShop(): Promise<void> {
  if (shopForm.name.trim().length < 2 || shopForm.address.trim().length < 3) return
  const ok = await fleet.createShop({
    name: shopForm.name.trim(),
    address: shopForm.address.trim(),
    ...(shopForm.phone.trim() ? { phone: shopForm.phone.trim() } : {}),
  })
  if (ok) {
    shopForm.name = ''
    shopForm.address = ''
    shopForm.phone = ''
    addingShop.value = false
  }
}

const mapShops = computed(() => fleet.shops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng })))

function fmtDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

onMounted(() => {
  fleet.loadFleet()
  fleet.loadShops()
  fleet.loadRecords()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-gray-900">Fleet</h1>
      <p class="text-sm text-gray-500">
        Inspection, registration, service and medical clocks — the same ones the dispatch engine checks
        before every trip. Log a service and the clock refreshes everywhere.
      </p>
    </div>

    <p v-if="fleet.error" class="text-sm text-red-600" role="alert">{{ fleet.error }}</p>
    <p v-if="serviceSaved" class="text-sm text-emerald-600" data-testid="service-saved">
      Service logged — the unit's compliance clock is refreshed.
    </p>

    <FleetMap :locations="[]" :shops="mapShops" />

    <!-- Log-a-service form -->
    <div v-if="serviceUnit" class="rounded-lg border border-primary-200 bg-primary-50/40 p-4" data-testid="service-form">
      <h2 class="text-sm font-semibold text-gray-900">Log service — {{ serviceUnit.label }}</h2>
      <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <label class="text-xs text-gray-600">
          Shop
          <select v-model="serviceForm.shopId" data-testid="service-shop" class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900" title="Nearest shop first, measured from the unit's last known position">
            <option v-for="s in shopOptions" :key="s.id" :value="s.id">{{ s.label }}</option>
          </select>
        </label>
        <label class="text-xs text-gray-600">
          Kind
          <select v-model="serviceForm.kind" data-testid="service-kind" class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900">
            <option value="service">Service (PM)</option>
            <option value="inspection">Inspection</option>
            <option value="registration">Registration</option>
            <option value="repair">Repair</option>
          </select>
        </label>
        <label class="text-xs text-gray-600">
          Performed
          <input v-model="serviceForm.performedAt" type="date" class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900" />
        </label>
        <label class="text-xs text-gray-600">
          Next due
          <input v-model="serviceForm.nextDueAt" type="date" data-testid="service-next-due" class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900" />
        </label>
        <label class="text-xs text-gray-600">
          Notes
          <input v-model="serviceForm.notes" class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900" />
        </label>
      </div>
      <div class="mt-3 flex gap-2">
        <button type="button" class="rounded bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700" data-testid="service-submit" @click="submitService">
          Save record
        </button>
        <button type="button" class="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50" @click="serviceUnit = null">
          Cancel
        </button>
      </div>
      <p v-if="!fleet.shops.length" class="mt-2 text-xs text-amber-600">Register a service shop below first.</p>
    </div>

    <!-- Tractors -->
    <div class="overflow-x-auto rounded-lg border border-gray-200">
      <div class="flex items-center gap-1 border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700">
        Tractors
        <InfoTip text="Expired clocks BLOCK dispatch; anything expiring during a planned trip warns in the assign checklist. Log a service to refresh a clock." />
      </div>
      <table class="w-full text-left text-sm" data-testid="tractors-table">
        <thead class="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th class="px-4 py-2 font-medium">Unit</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2 font-medium">Inspection</th>
            <th class="px-4 py-2 font-medium">Registration</th>
            <th class="px-4 py-2 font-medium">Next service</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="t in fleet.tractors" :key="t.id" :data-tractor-row="t.unit">
            <td class="px-4 py-2 font-medium text-gray-900">#{{ t.unit }} <span class="font-normal text-gray-500">{{ t.make ?? '' }}</span></td>
            <td class="px-4 py-2 text-gray-700">{{ t.status.replace('_', ' ') }}</td>
            <td class="px-4 py-2"><span class="rounded px-1.5 py-0.5 text-xs" :class="CHIP[chip(t.inspectionExpiresAt).level]" :data-chip="chip(t.inspectionExpiresAt).level">{{ chip(t.inspectionExpiresAt).label }}</span></td>
            <td class="px-4 py-2"><span class="rounded px-1.5 py-0.5 text-xs" :class="CHIP[chip(t.registrationExpiresAt).level]">{{ chip(t.registrationExpiresAt).label }}</span></td>
            <td class="px-4 py-2"><span class="rounded px-1.5 py-0.5 text-xs" :class="CHIP[chip(t.nextServiceAt).level]">{{ chip(t.nextServiceAt).label }}</span></td>
            <td class="px-4 py-2 text-right">
              <button type="button" class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50" :data-log-service="t.unit" @click="openService('tractor', t)">
                🔧 Log service
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Trailers -->
    <div class="overflow-x-auto rounded-lg border border-gray-200">
      <div class="border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700">Trailers</div>
      <table class="w-full text-left text-sm" data-testid="trailers-table">
        <thead class="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th class="px-4 py-2 font-medium">Unit</th>
            <th class="px-4 py-2 font-medium">Type</th>
            <th class="px-4 py-2 font-medium">Inspection</th>
            <th class="px-4 py-2 font-medium">Registration</th>
            <th class="px-4 py-2 font-medium">Next service</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="t in fleet.trailers" :key="t.id" :data-trailer-row="t.unit">
            <td class="px-4 py-2 font-medium text-gray-900">{{ t.unit }}</td>
            <td class="px-4 py-2 text-gray-700">{{ t.type }}</td>
            <td class="px-4 py-2"><span class="rounded px-1.5 py-0.5 text-xs" :class="CHIP[chip(t.inspectionExpiresAt).level]">{{ chip(t.inspectionExpiresAt).label }}</span></td>
            <td class="px-4 py-2"><span class="rounded px-1.5 py-0.5 text-xs" :class="CHIP[chip(t.registrationExpiresAt).level]">{{ chip(t.registrationExpiresAt).label }}</span></td>
            <td class="px-4 py-2"><span class="rounded px-1.5 py-0.5 text-xs" :class="CHIP[chip(t.nextServiceAt).level]">{{ chip(t.nextServiceAt).label }}</span></td>
            <td class="px-4 py-2 text-right">
              <button type="button" class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50" :data-log-service="t.unit" @click="openService('trailer', t)">
                🔧 Log service
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Driver medicals -->
    <div class="overflow-x-auto rounded-lg border border-gray-200">
      <div class="flex items-center gap-1 border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700">
        Driver medical certificates
        <InfoTip text="DOT medical cert expiry — an expired cert blocks dispatch, one expiring during a trip warns. Same clock rules as the units." />
      </div>
      <table class="w-full text-left text-sm" data-testid="medicals-table">
        <thead class="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr><th class="px-4 py-2 font-medium">Driver</th><th class="px-4 py-2 font-medium">Medical cert</th></tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="d in fleet.drivers" :key="d.id" :data-medical-row="d.name">
            <td class="px-4 py-2 font-medium text-gray-900">{{ d.name }}</td>
            <td class="px-4 py-2"><span class="rounded px-1.5 py-0.5 text-xs" :class="CHIP[chip(d.medicalCertExpiresAt).level]">{{ chip(d.medicalCertExpiresAt).label }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Shops -->
    <div class="rounded-lg border border-gray-200 p-4">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-gray-900">Service shops</h2>
        <button type="button" class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50" data-testid="add-shop-toggle" @click="addingShop = !addingShop">
          + Register shop
        </button>
      </div>
      <div v-if="addingShop" class="mt-3 flex flex-wrap items-end gap-2" data-testid="shop-form">
        <label class="text-xs text-gray-600">Name<input v-model="shopForm.name" data-testid="shop-name" class="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm text-gray-900" /></label>
        <label class="text-xs text-gray-600">Address<input v-model="shopForm.address" data-testid="shop-address" placeholder="City, ST" class="mt-1 block w-56 rounded border border-gray-300 px-2 py-1 text-sm text-gray-900" /></label>
        <label class="text-xs text-gray-600">Phone<input v-model="shopForm.phone" class="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm text-gray-900" /></label>
        <button type="button" class="rounded bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700" data-testid="shop-submit" @click="submitShop">Add</button>
      </div>
      <ul class="mt-3 flex flex-wrap gap-2" data-testid="shops-list">
        <li v-for="s in fleet.shops" :key="s.id" class="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-900">
          🔧 <b>{{ s.name }}</b> · {{ s.address }}<span v-if="s.phone"> · {{ s.phone }}</span>
        </li>
        <li v-if="!fleet.shops.length" class="text-xs text-gray-500">No shops registered yet.</li>
      </ul>
    </div>

    <!-- Maintenance ledger -->
    <div v-if="fleet.records.length" class="overflow-x-auto rounded-lg border border-gray-200">
      <div class="flex items-center gap-1 border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700">
        Maintenance ledger
        <InfoTip text="Which unit was maintained at which shop, when, and when the next visit is due — the audit trail behind the compliance chips above." />
      </div>
      <table class="w-full text-left text-sm" data-testid="records-table">
        <thead class="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th class="px-4 py-2 font-medium">Date</th>
            <th class="px-4 py-2 font-medium">Unit</th>
            <th class="px-4 py-2 font-medium">Shop</th>
            <th class="px-4 py-2 font-medium">Kind</th>
            <th class="px-4 py-2 font-medium">Next due</th>
            <th class="px-4 py-2 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="r in fleet.records" :key="r.id">
            <td class="px-4 py-2 text-gray-700">{{ fmtDay(r.performedAt) }}</td>
            <td class="px-4 py-2 font-medium text-gray-900">{{ r.unit }}</td>
            <td class="px-4 py-2 text-gray-700">{{ r.shopName }}</td>
            <td class="px-4 py-2 text-gray-700">{{ r.kind }}</td>
            <td class="px-4 py-2 text-gray-700">{{ fmtDay(r.nextDueAt) }}</td>
            <td class="px-4 py-2 text-gray-500">{{ r.notes ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import FieldMapper from '../components/import/FieldMapper.vue'
import type { ColumnMapping } from '../lib/importMapping'
import { autoMap, buildRows, missingRequired, parseCsv } from '../lib/importMapping'
import type { ImportEntity } from '../stores/importer'
import { useImporterStore } from '../stores/importer'

// The onboarding wedge: paste a CSV export from the fleet's existing TMS/ELD
// and see the dispatch board fill up. Exact-header pastes import directly;
// "Preview & map" handles the real world, where every TMS names its columns
// differently — headers are matched to our fields client-side and the server
// receives canonical rows (it still validates each one).
const importer = useImporterStore()

const entity = ref<ImportEntity>('loads')
const csv = ref('')
const headers = ref<string[]>([])
const dataRows = ref<string[][]>([])
const mapping = ref<ColumnMapping>([])

const TEMPLATES: Record<ImportEntity, string> = {
  loads:
    'externalId,requiredEquip,revenueCents,fscCents,hazmatClass,pickupAddress,pickupLat,pickupLng,pickupWindowStart,pickupWindowEnd,deliveryAddress,deliveryLat,deliveryLng,deliveryWindowEnd',
  drivers: 'email,name,externalId,phone,hazmatEndorsed,lat,lng',
  hos: 'email,driveRemainingMin,windowRemainingMin,cycleRemainingMin,minutesSinceBreak',
}

const mapperOpen = computed(() => headers.value.length > 0)
const samples = computed(() => headers.value.map((_, i) => dataRows.value[0]?.[i] ?? ''))
const missing = computed(() => missingRequired(mapping.value, entity.value))
const mappedPreview = computed(() => buildRows(dataRows.value.slice(0, 5), mapping.value))
const previewColumns = computed(() => {
  const keys = new Set<string>()
  for (const row of mappedPreview.value) Object.keys(row).forEach((k) => keys.add(k))
  return [...keys]
})

function preview(): void {
  const rows = parseCsv(csv.value)
  if (rows.length < 2) {
    importer.error = 'Paste a header row plus at least one data row first'
    return
  }
  importer.reset()
  headers.value = rows[0]
  dataRows.value = rows.slice(1)
  mapping.value = autoMap(rows[0], entity.value)
}

function closeMapper(): void {
  headers.value = []
  dataRows.value = []
  mapping.value = []
}

// The mapper holds rows parsed at preview time; any edit to the textarea
// invalidates them — close the mapper so Import can never commit stale rows.
watch(csv, () => {
  if (mapperOpen.value) closeMapper()
})

async function submit(): Promise<void> {
  if (mapperOpen.value) {
    if (missing.value.length) return
    await importer.importRows(entity.value, buildRows(dataRows.value, mapping.value))
    if (importer.report) closeMapper()
    return
  }
  if (!csv.value.trim()) return
  await importer.importCsv(entity.value, csv.value)
}

function pick(next: ImportEntity): void {
  entity.value = next
  importer.reset()
  closeMapper()
}

const curlExample = computed(() => {
  if (!importer.webhookKey) return ''
  return [
    `curl -X POST ${window.location.origin.replace(/:\d+$/, ':3001')}${importer.webhookUrl}`,
    `  -H "x-api-key: ${importer.webhookKey}" -H "content-type: application/json"`,
    `  -d '{"externalId":"L-1001","requiredEquip":"DryVan","revenueCents":45000,"pickupAddress":"Kansas City, MO","deliveryAddress":"Omaha, NE"}'`,
  ].join(' \\\n')
})

onMounted(() => importer.loadWebhookKey())
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-semibold text-gray-900">Data import</h1>
      <p class="text-sm text-gray-500">
        Paste a CSV export from your TMS / ELD. Good rows import; bad rows come back with reasons.
      </p>
    </div>

    <div class="flex gap-2" data-testid="entity-tabs">
      <button
        v-for="e in (['loads', 'drivers', 'hos'] as ImportEntity[])"
        :key="e"
        type="button"
        class="rounded-md px-3 py-1.5 text-sm font-medium capitalize"
        :class="entity === e ? 'bg-primary-600 text-white' : 'border border-gray-300 text-gray-700 hover:bg-gray-50'"
        :data-entity="e"
        @click="pick(e)"
      >
        {{ e }}
      </button>
    </div>

    <div class="rounded-md bg-gray-50 p-2 text-xs text-gray-500">
      Columns: <code class="break-all">{{ TEMPLATES[entity] }}</code>
      — or paste any CSV and use <span class="font-medium">Preview &amp; map</span>.
    </div>

    <textarea
      v-model="csv"
      rows="10"
      class="w-full rounded-md border border-gray-300 p-2 font-mono text-xs"
      :placeholder="`${TEMPLATES[entity]}\n…paste rows here…`"
      data-testid="csv-input"
    ></textarea>

    <div class="flex items-center gap-2">
      <button
        type="button"
        class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        :disabled="!csv.trim()"
        data-testid="preview-btn"
        @click="preview"
      >
        Preview &amp; map
      </button>
      <button
        type="button"
        class="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
        :disabled="importer.submitting || !csv.trim() || (mapperOpen && missing.length > 0)"
        data-testid="import-btn"
        @click="submit"
      >
        {{ importer.submitting ? 'Importing…' : mapperOpen ? `Import ${dataRows.length} rows` : 'Import' }}
      </button>
      <button
        v-if="mapperOpen"
        type="button"
        class="text-sm text-gray-500 hover:text-gray-700"
        data-testid="close-mapper"
        @click="closeMapper"
      >
        Cancel mapping
      </button>
    </div>

    <FieldMapper
      v-if="mapperOpen"
      :entity="entity"
      :headers="headers"
      :samples="samples"
      :mapping="mapping"
      @update="mapping = $event"
    />

    <div v-if="mapperOpen && previewColumns.length" class="overflow-x-auto rounded-lg border border-gray-200" data-testid="mapped-preview">
      <table class="w-full text-left text-xs">
        <thead class="bg-gray-50 text-gray-500">
          <tr>
            <th v-for="col in previewColumns" :key="col" class="px-3 py-2 font-medium">{{ col }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 text-gray-800">
          <tr v-for="(row, i) in mappedPreview" :key="i">
            <td v-for="col in previewColumns" :key="col" class="px-3 py-1.5">{{ row[col] ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="importer.error" class="text-sm text-red-600" role="alert">{{ importer.error }}</p>

    <div class="rounded-lg border border-gray-200 p-4" data-testid="webhook-card">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium text-gray-800">Push ingest (webhook)</p>
          <p class="text-xs text-gray-500">
            Let your TMS push loads continuously to
            <code class="font-mono">{{ importer.webhookUrl ?? '/api/webhooks/loads' }}</code>
            with an <code class="font-mono">x-api-key</code> header.
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          :disabled="importer.webhookBusy"
          data-testid="webhook-generate"
          @click="importer.generateWebhookKey()"
        >
          {{ importer.webhookKey ? 'Rotate key' : 'Generate key' }}
        </button>
      </div>

      <div v-if="importer.webhookKey" class="mt-3 flex flex-col gap-2">
        <p class="text-xs text-amber-600">Rotating invalidates the previous key immediately.</p>
        <code class="break-all rounded bg-gray-50 p-2 font-mono text-xs text-gray-800" data-testid="webhook-key">{{
          importer.webhookKey
        }}</code>
        <pre class="overflow-x-auto rounded bg-gray-900 p-3 font-mono text-[11px] leading-relaxed text-gray-100">{{ curlExample }}</pre>
      </div>
    </div>

    <div v-if="importer.report" class="rounded-lg border border-gray-200 p-4" data-testid="import-report">
      <p class="text-sm font-medium text-emerald-700">✓ {{ importer.report.imported }} rows imported</p>
      <div v-if="importer.report.errors.length" class="mt-2">
        <p class="text-sm font-medium text-red-600">{{ importer.report.errors.length }} rows rejected:</p>
        <ul class="mt-1 space-y-0.5 text-sm text-gray-700">
          <li v-for="err in importer.report.errors" :key="err.row">
            <span class="font-mono text-xs text-gray-400">row {{ err.row }}</span> — {{ err.error }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

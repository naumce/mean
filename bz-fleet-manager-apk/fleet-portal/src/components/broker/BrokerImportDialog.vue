<script setup lang="ts">
import { ref } from 'vue'
import type { BrokerImportResult, BrokerPreview } from '../../lib/api'
import { useBrokerBoardStore } from '../../stores/brokerBoard'

// Import → preview the first loads as row pairs → confirm. Nothing is
// written until Confirm; unreadable cells show as notes, not errors.
const emit = defineEmits<{ (e: 'close'): void; (e: 'imported', r: BrokerImportResult): void }>()
const store = useBrokerBoardStore()
const file = ref<File | null>(null)
const preview = ref<BrokerPreview | null>(null)
const result = ref<BrokerImportResult | null>(null)

async function pick(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0] ?? null
  file.value = f; preview.value = null; result.value = null
  if (f) preview.value = await store.preview(f)
}
async function confirm() {
  if (!file.value) return
  const r = await store.confirm(file.value)
  if (r) { result.value = r; emit('imported', r) }
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="Import your board">
    <div class="w-[min(960px,95vw)] max-h-[90vh] overflow-auto rounded-lg border border-line bg-surface p-5 text-ink shadow-xl">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-lg font-semibold">Import your board</h2>
          <p class="text-sm text-ink-2">Pick the .xlsx you use today. We read the header row, show the first loads the way they'll appear, and write nothing until you confirm.</p>
        </div>
        <button class="rounded px-2 py-1 text-ink-2 hover:bg-surface-2" @click="emit('close')" aria-label="Close">✕</button>
      </div>
      <input type="file" accept=".xlsx" class="mt-4 block" @change="pick" />
      <p v-if="store.importError" class="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700 dark:border-red-500 dark:bg-red-950/40 dark:text-red-300">{{ store.importError }}</p>
      <div v-if="preview" class="mt-4 space-y-3">
        <p class="text-sm"><span v-if="preview.sheetName">Sheet <strong>{{ preview.sheetName }}</strong>: </span><strong>{{ preview.loads.length }}</strong> loads found. Columns: {{ preview.layout.filter((c) => c.key !== 'extra' && c.key !== 'agent').length }} recognized<span v-if="preview.unmatched.length">, not imported in this version: {{ preview.unmatched.join(', ') }}</span>.</p>
        <p v-if="preview.missing.length" class="text-sm text-amber-700 dark:text-amber-400">Missing columns: {{ preview.missing.join(', ') }}. The board still imports; the agent needs LOAD# and APPT SCHEDULE to work a load.</p>
        <!-- Rows the reader skipped, other tabs it found, duplicate LOAD#s: what
             happens to the file has to be visible before Confirm, not after. -->
        <ul v-if="preview.notes.length" data-preview-notes class="list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-400">
          <li v-for="n in preview.notes" :key="n">{{ n }}</li>
        </ul>
        <table class="w-full text-xs">
          <thead><tr class="text-left text-ink-2"><th class="py-1">Line</th><th>LOAD#</th><th>Customer</th><th>Carrier</th><th>Pick up</th><th>Delivery</th><th>Rate</th><th>Notes</th></tr></thead>
          <tbody>
            <tr v-for="l in preview.loads.slice(0, 10)" :key="l.line" class="border-t border-line">
              <td class="py-1">{{ l.line }}</td><td>{{ l.loadNo ?? '—' }}</td><td>{{ l.customer }}</td><td>{{ l.carrier ?? '— (no carrier yet)' }}</td><td>{{ l.pickup }}</td><td>{{ l.delivery }}</td><td>{{ l.rateCents == null ? '' : '$' + (Number(l.rateCents) / 100).toFixed(2) }}</td>
              <td class="text-amber-700 dark:text-amber-400">{{ l.notes.join('; ') }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="preview.loads.length > 10" class="text-xs text-ink-3">…and {{ preview.loads.length - 10 }} more.</p>
        <div class="flex items-center gap-3">
          <button class="rounded bg-brand px-4 py-2 text-sm font-semibold text-brand-ink disabled:opacity-50" :disabled="store.importing || !file" @click="confirm">Confirm import</button>
          <span v-if="result" class="text-sm text-green-700 dark:text-green-400">Imported: {{ result.created }} new, {{ result.updated }} updated<span v-if="result.archivedKept">, {{ result.archivedKept }} left archived (turn on &quot;Show archived&quot; to see {{ result.archivedKept === 1 ? 'it' : 'them' }})</span><span v-if="result.skipped">, {{ result.skipped }} skipped</span><span v-if="result.attention">, {{ result.attention }} need attention</span>.</span>
        </div>
        <!-- F10: a row the importer left alone because a dispatcher was in
             it (spec §7.3). Not an error and not a silent drop — the notes
             below name each row and its holder. -->
        <p v-if="result && result.locked" data-locked-skipped class="text-sm text-amber-700 dark:text-amber-400">{{ result.locked }} {{ result.locked === 1 ? 'row' : 'rows' }} being edited {{ result.locked === 1 ? 'was' : 'were' }} skipped.</p>
        <ul v-if="result && result.notes.length" data-result-notes class="list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-400">
          <li v-for="n in result.notes" :key="n">{{ n }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

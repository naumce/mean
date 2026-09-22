<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppButton from '../../components/AppButton.vue'
import Modal from '../../components/Modal.vue'
import { useAuthStore } from '../../stores/auth'
import { useNightShiftStore } from '../../stores/nightShift'
import { SHEET_COLUMN_KEYS, REQUIRED_KEYS, useSheetStore, type SheetColumnKey, type SheetMapping } from '../stores/sheet'

// Task 11: the Connect tab (spec §9.3) — five steps on one scrolling page,
// the current step expanded. A dispatcher on the sole "sheet" tier never
// touches a board import; this IS their onboarding.
const route = useRoute()
const sheet = useSheetStore()
const auth = useAuthStore()
const nightShift = useNightShiftStore()

const STANDARD_NAME = 'Standard'
const DONE_SENTENCE = 'Choose a policy in the Night Shift column on any row to start. Everything runs in shadow until you go live in Settings.'

const KEY_LABELS: Record<SheetColumnKey, string> = {
  loadRef: 'Load #',
  driverPhone: 'Driver phone',
  driverName: 'Driver name',
  pickup: 'Pickup',
  delivery: 'Delivery',
  pickupAppt: 'Pickup appointment',
  deliveryAppt: 'Delivery appointment',
  customerEmail: 'Customer email',
  carrierName: 'Carrier name',
  carrierPhone: 'Carrier phone',
  rate: 'Rate',
  notes: 'Notes',
}
const isRequired = (key: SheetColumnKey): boolean => (REQUIRED_KEYS as readonly string[]).includes(key)

// The wizard, once entered, stays on its own step even after a mid-flow
// action (saveMapping) flips `sheet.binding.status` to "connected" — without
// this flag, finishing step 3 would immediately swap the whole page over to
// the "already connected" summary card and steps 4/5 would never show.
const inWizard = ref(false)
const step = ref<1 | 2 | 3 | 4 | 5>(1)
const installedJustNow = ref(false)

const isFullyConnected = computed(() => sheet.binding?.status === 'connected')
const isPending = computed(() => !!sheet.binding && sheet.binding.status !== 'connected' && !sheet.binding.spreadsheetId)

onMounted(async () => {
  await sheet.load()
  // Loaded up front (not lazily, only once step 4 or the summary's Edit
  // contacts is reached) so the summary card's "no dispatcher phone yet"
  // hint (fix round 1, finding 2) has Standard's current contact fields to
  // read on first render, not just after a dispatcher clicks something.
  await nightShift.loadPolicies()
  const wantsStep2 = String(route.query.step ?? '') === '2'
  if (isFullyConnected.value && !wantsStep2) {
    inWizard.value = false
    return
  }
  inWizard.value = true
  step.value = isPending.value || wantsStep2 ? 2 : 1
})

// --- Step 1 ------------------------------------------------------------
async function onSignIn(): Promise<void> {
  await sheet.startOAuth()
}

// --- Step 2 --------------------------------------------------------------
// Final fix wave, C1: no spreadsheet listing (no Drive scope). The
// dispatcher pastes the sheet's link; the store pulls the id out of it and
// asks the server for the title and tabs.
const sheetLink = ref('')
async function onOpenSpreadsheet(): Promise<void> {
  await sheet.openSpreadsheet(sheetLink.value)
}
async function onPickTab(id: string): Promise<void> {
  if (!id) return
  sheet.pickTab(id)
  await sheet.readHeader()
  step.value = 3
}

// --- Step 3 ----------------------------------------------------------------
const mappingDraft = reactive<SheetMapping>({})
watch(
  () => sheet.proposal,
  (proposal) => {
    Object.keys(mappingDraft).forEach((k) => delete mappingDraft[k as SheetColumnKey])
    if (proposal) Object.assign(mappingDraft, proposal.mapping)
  },
  { immediate: true },
)
const isMissing = (key: SheetColumnKey): boolean => isRequired(key) && !mappingDraft[key]
// Two-rows-per-load sheets: pre-checked from the server's look at the first
// rows under the header (a carrier row with no cities under each load), or
// from the binding itself when re-mapping.
const TWO_ROWS_LABEL = 'Each load takes two rows (customer row + carrier row)'
const TWO_ROWS_HELP = "The top row is the load; the carrier row below it supplies the carrier's phone, contact and LOAD#. Night Shift's two cells go on the top row."
const twoRows = ref(false)
watch(
  () => sheet.suggestedRowsPerLoad,
  (suggested) => {
    twoRows.value = suggested === 2
  },
  { immediate: true },
)
const mappingError = ref<string | null>(null)
async function onSaveMapping(): Promise<void> {
  mappingError.value = null
  try {
    await sheet.saveMapping({ ...mappingDraft }, twoRows.value ? 2 : 1)
    step.value = 4
  } catch {
    mappingError.value = sheet.error
  }
}

// --- Step 4 (and, fix round 1 finding 2, the summary's Edit contacts) ------
const standardPolicy = computed(() => nightShift.policies.find((p) => p.name === STANDARD_NAME) ?? null)
const contactEmail = ref('')
const contactPhone = ref('')
watch(
  () => auth.dispatcher?.email,
  (email) => {
    if (email && !contactEmail.value) contactEmail.value = email
  },
  { immediate: true },
)
const orgTimezone = computed(() => auth.org?.timezone ?? null)
const contactError = ref<string | null>(null)

/** Writes the two contact fields into the Standard policy via the existing
 *  `savePolicy` (the whole policy — there is no partial-patch route).
 *  Returns whether it landed; the two callers (step 4's Continue and the
 *  summary's Edit contacts) each decide what "landed" means for them. */
async function saveContactsToStandard(): Promise<boolean> {
  contactError.value = null
  const standard = standardPolicy.value
  if (!standard) {
    contactError.value = 'No Standard policy found yet — visit the Policies tab first.'
    return false
  }
  try {
    await nightShift.savePolicy({
      ...standard,
      dispatcherEmail: contactEmail.value,
      dispatcherPhone: contactPhone.value.trim() ? contactPhone.value.trim() : null,
    })
    return true
  } catch {
    contactError.value = nightShift.error
    return false
  }
}
async function onSaveContacts(): Promise<void> {
  if (await saveContactsToStandard()) step.value = 5
}

// Fix round 1, finding 2: POST /mapping already flips the binding to
// "connected" (backend unchanged by design), so a refresh between steps 3
// and 5 lands straight on the summary card with no way back to step 4. This
// reopens it in place, prefilled from Standard's OWN current contact fields
// (not the session email again — a dispatcher may have already set something
// different) rather than re-running the whole wizard.
const editingContacts = ref(false)
const missingPhoneHint = computed(() => isFullyConnected.value && !!standardPolicy.value && !standardPolicy.value.dispatcherPhone)
function onEditContacts(): void {
  const standard = standardPolicy.value
  contactEmail.value = standard?.dispatcherEmail ?? auth.dispatcher?.email ?? ''
  contactPhone.value = standard?.dispatcherPhone ?? ''
  contactError.value = null
  editingContacts.value = true
}
async function onSaveContactsEdit(): Promise<void> {
  if (await saveContactsToStandard()) editingContacts.value = false
}

// --- Step 5 --------------------------------------------------------------
async function onInstall(): Promise<void> {
  await sheet.install()
  installedJustNow.value = true
}

// --- Connected summary -----------------------------------------------------
// Fix round 1, finding 1: "Sync now" used to discard the report and never
// refresh `binding`, so it looked like nothing happened and "Last sync"
// stayed stale. The store's `syncNow()` now reloads the binding itself; this
// only needs to render the report it already returned.
async function onSyncNow(): Promise<void> {
  try {
    await sheet.syncNow()
  } catch {
    // sheet.error already reflects the refusal — the banner above shows it.
  }
}
const syncResultText = computed(() => {
  const r = sheet.lastReport
  if (!r) return null
  let text = `Synced just now — ${r.read} row${r.read === 1 ? '' : 's'} read, ${r.created} new, ${r.updated} updated, ${r.statusWrites} status cell${r.statusWrites === 1 ? '' : 's'} written`
  if (r.skipped.length > 0) {
    const reasons = r.skipped.map((s) => s.reason)
    const shown = reasons.slice(0, 3)
    text += `, ${r.skipped.length} skipped (${shown.join('; ')}${reasons.length > 3 ? '; …' : ''})`
  }
  return text
})
function onRemap(): void {
  inWizard.value = true
  step.value = 3
  void sheet.reenterMapping()
}
const showDisconnectConfirm = ref(false)
async function onConfirmDisconnect(): Promise<void> {
  await sheet.disconnect()
  showDisconnectConfirm.value = false
  inWizard.value = true
  step.value = 1
}

// Minor (fix round 1): steps 2–4 can step back without losing what was
// already entered — nothing here clears `sheet`'s selections or the local
// `contactEmail`/`contactPhone` refs, so re-advancing lands right back where
// it was.
function backTo(n: 1 | 2 | 3): void {
  step.value = n
}
</script>

<template>
  <div class="flex flex-col gap-6" data-testid="connect-sheet">
    <div>
      <h1 class="text-xl font-semibold text-ink">Connect your sheet</h1>
      <p class="mt-2 max-w-3xl text-sm leading-relaxed text-ink-2">
        Link the Google Sheet you already dispatch from — the night shift agent reads and writes it directly, no board import needed.
      </p>
    </div>

    <p v-if="sheet.error" class="text-sm text-red-600" role="alert" data-testid="sheet-error">{{ sheet.error }}</p>

    <!-- Connected summary -->
    <div v-if="!inWizard && sheet.binding" class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5" data-testid="sheet-summary">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-sm font-semibold text-ink" data-testid="summary-title">{{ sheet.binding.spreadsheetTitle || sheet.binding.tabTitle || sheet.binding.spreadsheetId }}</h2>
          <p class="text-xs text-ink-3">Tab: {{ sheet.binding.tabTitle }}<template v-if="sheet.binding.rowsPerLoad === 2"> — 2 rows per load</template></p>
          <p class="text-xs text-ink-3">Account: {{ sheet.binding.accountEmail }}</p>
          <p class="text-xs text-ink-3">Last sync: {{ sheet.binding.lastSyncAt ?? 'never' }}</p>
          <p v-if="sheet.binding.lastError" class="text-xs text-red-600" data-testid="sheet-last-error">{{ sheet.binding.lastError }}</p>
        </div>
      </div>

      <p v-if="!sheet.binding.agentSwitchCol" class="text-sm text-amber-700" data-testid="columns-not-installed">
        The Night Shift columns are not installed on this tab yet.
      </p>

      <p v-if="syncResultText" class="text-xs text-ink-2" data-testid="sync-result">{{ syncResultText }}</p>

      <div class="flex flex-wrap items-center gap-2">
        <AppButton v-if="!sheet.binding.agentSwitchCol" type="button" data-testid="install-columns" @click="onInstall">Install</AppButton>
        <AppButton type="button" variant="ghost" data-testid="sync-now" :loading="sheet.loading" @click="onSyncNow">Sync now</AppButton>
        <AppButton type="button" variant="ghost" data-testid="re-map" @click="onRemap">Re-map</AppButton>
        <AppButton type="button" variant="ghost" data-testid="edit-contacts" @click="onEditContacts">Edit contacts</AppButton>
        <span v-if="missingPhoneHint" class="text-xs text-amber-700" data-testid="missing-phone-hint">No dispatcher phone yet — the agent can't call you at night</span>
        <AppButton type="button" variant="danger" data-testid="disconnect" @click="showDisconnectConfirm = true">Disconnect</AppButton>
      </div>

      <!-- Fix round 1, finding 2: edit contacts in place, no full re-wizard. -->
      <div v-if="editingContacts" class="mt-2 flex flex-col gap-3 rounded-lg border border-line p-4 sm:max-w-sm" data-testid="edit-contacts-step">
        <h3 class="text-sm font-semibold text-ink">Edit contacts</h3>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium text-ink-2">Dispatcher email</span>
          <input id="edit-dispatcher-email" v-model="contactEmail" type="email" required class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium text-ink-2">Dispatcher phone</span>
          <input id="edit-dispatcher-phone" v-model="contactPhone" type="tel" placeholder="+15551234567" class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink" />
        </label>
        <p v-if="contactError" class="text-sm text-red-600" role="alert" data-testid="edit-contacts-error">{{ contactError }}</p>
        <div class="flex gap-2">
          <AppButton type="button" data-testid="save-contacts-edit" @click="onSaveContactsEdit">Save</AppButton>
          <AppButton type="button" variant="ghost" @click="editingContacts = false">Cancel</AppButton>
        </div>
      </div>
    </div>

    <!-- The five-step wizard -->
    <div v-else class="flex flex-col gap-4">
      <!-- Step 1: sign in -->
      <section class="rounded-xl border border-line bg-surface p-5" :class="step === 1 ? '' : 'opacity-60'" data-testid="step-1">
        <h2 class="text-sm font-semibold text-ink">1. Sign in with Google</h2>
        <p class="mt-1 text-xs text-ink-3">We only ask for access to the sheets you pick in the next step.</p>
        <AppButton v-if="step === 1" type="button" class="mt-3" data-testid="sign-in-google" @click="onSignIn">Sign in with Google</AppButton>
      </section>

      <!-- Step 2: pick spreadsheet + tab -->
      <section v-if="step >= 2" class="rounded-xl border border-line bg-surface p-5" :class="step === 2 ? '' : 'opacity-60'" data-testid="step-2">
        <h2 class="text-sm font-semibold text-ink">2. Pick your spreadsheet and tab</h2>
        <button v-if="step === 2" type="button" class="mt-1 text-xs text-ink-3 underline hover:text-ink" data-testid="back-to-1" @click="backTo(1)">Back</button>
        <div v-if="step === 2" class="mt-3 flex flex-col gap-3 sm:max-w-sm">
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium text-ink-2">Paste the link to your Google Sheet</span>
            <input
              v-model="sheetLink"
              data-testid="sheet-link"
              type="url"
              placeholder="https://docs.google.com/spreadsheets/d/…"
              class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
              @keydown.enter.prevent="onOpenSpreadsheet"
            />
          </label>
          <AppButton type="button" class="self-start" :loading="sheet.loading" data-testid="open-spreadsheet" @click="onOpenSpreadsheet">Open</AppButton>

          <p v-if="sheet.selectedSpreadsheetTitle" class="text-sm text-ink" data-testid="spreadsheet-title">{{ sheet.selectedSpreadsheetTitle }}</p>

          <label v-if="sheet.selectedSpreadsheetId && sheet.tabs.length" class="flex flex-col gap-1 text-sm">
            <span class="font-medium text-ink-2">Tab</span>
            <select
              data-testid="tab-select"
              class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
              :value="sheet.selectedTabId ?? ''"
              @change="onPickTab(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>Choose a tab…</option>
              <option v-for="t in sheet.tabs" :key="t.id" :value="t.id">{{ t.title }}</option>
            </select>
          </label>
        </div>
      </section>

      <!-- Step 3: mapping -->
      <section v-if="step >= 3" class="rounded-xl border border-line bg-surface p-5" :class="step === 3 ? '' : 'opacity-60'" data-testid="step-3">
        <h2 class="text-sm font-semibold text-ink">3. Match your columns</h2>
        <button v-if="step === 3" type="button" class="mt-1 text-xs text-ink-3 underline hover:text-ink" data-testid="back-to-2" @click="backTo(2)">Back</button>
        <div v-if="step === 3" class="mt-3 flex flex-col gap-3">
          <table class="w-full text-left text-sm" data-testid="mapping-table">
            <thead>
              <tr class="text-xs uppercase tracking-wide text-ink-3">
                <th class="py-1 pr-3">Field</th>
                <th class="py-1">Your column</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="key in SHEET_COLUMN_KEYS" :key="key" :class="isMissing(key) ? 'bg-red-50 dark:bg-red-950/30' : ''" :data-testid="`mapping-row-${key}`">
                <td class="py-1 pr-3">
                  {{ KEY_LABELS[key] }}
                  <span v-if="isRequired(key)" class="text-red-600" aria-label="required">*</span>
                  <span v-if="isMissing(key)" class="ml-1 text-xs text-red-600" :data-testid="`missing-${key}`">missing</span>
                </td>
                <td class="py-1">
                  <select
                    :data-testid="`map-select-${key}`"
                    class="rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink"
                    :value="mappingDraft[key] ?? ''"
                    @change="mappingDraft[key] = ($event.target as HTMLSelectElement).value || undefined"
                  >
                    <option v-if="!isRequired(key)" value="">— not mapped —</option>
                    <option value="" v-else disabled>Choose a column…</option>
                    <option v-for="h in sheet.header" :key="h" :value="h">{{ h }}</option>
                  </select>
                </td>
              </tr>
            </tbody>
          </table>

          <p v-if="sheet.proposal?.extras?.length" class="text-xs text-ink-3" data-testid="mapping-extras">
            kept as extra: {{ sheet.proposal.extras.join(', ') }}
          </p>

          <label class="flex items-start gap-2 text-sm text-ink">
            <input v-model="twoRows" type="checkbox" class="mt-1" data-testid="two-rows" />
            <span>
              {{ TWO_ROWS_LABEL }}
              <span class="block text-xs text-ink-3">{{ TWO_ROWS_HELP }}</span>
            </span>
          </label>

          <p v-if="mappingError" class="text-sm text-red-600" role="alert" data-testid="mapping-error">{{ mappingError }}</p>

          <AppButton type="button" class="self-start" :loading="sheet.loading" data-testid="save-mapping" @click="onSaveMapping">Continue</AppButton>
        </div>
      </section>

      <!-- Step 4: contacts -->
      <section v-if="step >= 4" class="rounded-xl border border-line bg-surface p-5" :class="step === 4 ? '' : 'opacity-60'" data-testid="step-4">
        <h2 class="text-sm font-semibold text-ink">4. Who the agent contacts</h2>
        <button v-if="step === 4" type="button" class="mt-1 text-xs text-ink-3 underline hover:text-ink" data-testid="back-to-3" @click="backTo(3)">Back</button>
        <div v-if="step === 4" class="mt-3 flex flex-col gap-3 sm:max-w-sm">
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium text-ink-2">Dispatcher email</span>
            <input id="connect-dispatcher-email" v-model="contactEmail" type="email" required class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink" />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium text-ink-2">Dispatcher phone</span>
            <input id="connect-dispatcher-phone" v-model="contactPhone" type="tel" placeholder="+15551234567" class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink" />
          </label>
          <p v-if="orgTimezone" class="text-xs text-ink-3">Time zone: {{ orgTimezone }}</p>

          <p v-if="contactError" class="text-sm text-red-600" role="alert" data-testid="contacts-error">{{ contactError }}</p>

          <AppButton type="button" class="self-start" data-testid="save-contacts" @click="onSaveContacts">Continue</AppButton>
        </div>
      </section>

      <!-- Step 5: install -->
      <section v-if="step >= 5" class="rounded-xl border border-line bg-surface p-5" data-testid="step-5">
        <h2 class="text-sm font-semibold text-ink">5. Install</h2>
        <div class="mt-3 flex flex-col gap-3">
          <p v-if="!installedJustNow" class="text-sm text-ink-2">Add the Night Shift columns to your sheet.</p>
          <AppButton v-if="!installedJustNow" type="button" class="self-start" :loading="sheet.loading" data-testid="do-install" @click="onInstall">Install</AppButton>
          <p v-else class="text-sm text-ink" data-testid="done-sentence">{{ DONE_SENTENCE }}</p>
        </div>
      </section>
    </div>

    <!-- Disconnect confirmation -->
    <Modal v-model:open="showDisconnectConfirm">
      <template #header>
        <h2 class="text-lg font-semibold text-ink">Disconnect this sheet?</h2>
      </template>
      <p class="text-sm text-ink-2">The agent will stop reading and writing it until you connect again.</p>
      <template #footer>
        <AppButton type="button" variant="ghost" @click="showDisconnectConfirm = false">Cancel</AppButton>
        <AppButton type="button" variant="danger" data-testid="confirm-disconnect" @click="onConfirmDisconnect">Disconnect</AppButton>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import AppButton from '../components/AppButton.vue'
import Modal from '../components/Modal.vue'
import ConnectSheet from '../nightshift/components/ConnectSheet.vue'
import { useSheetStore } from '../nightshift/stores/sheet'
import { useAuthStore } from '../stores/auth'
import { useNightShiftStore, type AgentPolicy, type AgentPolicyInput } from '../stores/nightShift'

// The Night Shift setup screen (spec §17.2). This is the pitch: a prospect
// who has never seen the product lands here and sees that the agent is a
// configurable, supervised policy — not a black box that decides on its own
// what to do with someone's truck.
const store = useNightShiftStore()

// Task 11: four tabs share this route (AppShell's sheet-tier nav links
// straight to `?tab=usage`/`?tab=settings` — see its own comment). "connect"
// and "policies" are real; "usage"/"settings" are the next plan's and get a
// one-line placeholder here so the nav's four links all land somewhere real.
type NightShiftTab = 'connect' | 'policies' | 'usage' | 'settings'
const route = useRoute()
const auth = useAuthStore()
const sheet = useSheetStore()
const activeTab = ref<NightShiftTab>('policies')

async function resolveInitialTab(): Promise<void> {
  const requested = route.query.tab
  if (requested === 'connect' || requested === 'usage' || requested === 'settings' || requested === 'policies') {
    activeTab.value = requested
    return
  }
  // No `?tab=` at all: a sheet-tier org with nothing connected yet lands on
  // Connect (this IS their onboarding); everyone else — tower tier, or a
  // sheet-tier org that already has a binding — lands on Policies as before.
  if (auth.tier === 'sheet') {
    await sheet.load()
    activeTab.value = sheet.binding?.status === 'connected' ? 'policies' : 'connect'
  } else {
    activeTab.value = 'policies'
  }
}

const STANDARD_NAME = 'Standard'

interface PolicyForm {
  id: string | null
  name: string
  stopMin: number
  delayMin: number
  darkMin: number
  darkAtStopMin: number
  offRouteMi: number
  offRouteMin: number
  rungGapMin: number
  maxCalls: number
  dispatcherEmail: string
  dispatcherPhone: string
  customerEmailOn: boolean
  shadow: boolean
  bossCallOn: boolean
  quietFrom: string
  quietTo: string
}

function blankForm(): PolicyForm {
  return {
    id: null,
    name: '',
    stopMin: 15,
    delayMin: 30,
    darkMin: 20,
    darkAtStopMin: 60,
    offRouteMi: 3.1,
    offRouteMin: 10,
    rungGapMin: 5,
    maxCalls: 2,
    dispatcherEmail: '',
    dispatcherPhone: '',
    customerEmailOn: false,
    shadow: true,
    bossCallOn: true,
    quietFrom: '',
    quietTo: '',
  }
}

function policyToForm(policy: AgentPolicy): PolicyForm {
  return {
    id: policy.id,
    name: policy.name,
    stopMin: policy.stopMin,
    delayMin: policy.delayMin,
    darkMin: policy.darkMin,
    darkAtStopMin: policy.darkAtStopMin,
    offRouteMi: policy.offRouteMi,
    offRouteMin: policy.offRouteMin,
    rungGapMin: policy.rungGapMin,
    maxCalls: policy.maxCalls,
    dispatcherEmail: policy.dispatcherEmail,
    dispatcherPhone: policy.dispatcherPhone ?? '',
    customerEmailOn: policy.customerEmailOn,
    shadow: policy.shadow,
    bossCallOn: policy.bossCallOn,
    quietFrom: policy.quietFrom ?? '',
    quietTo: policy.quietTo ?? '',
  }
}

const selectedId = ref<string | null>(null)
const form = reactive<PolicyForm>(blankForm())
const isNew = computed(() => selectedId.value === null)
const isSelectedStandard = computed(() => {
  const policy = store.policies.find((p) => p.id === selectedId.value)
  return policy?.name === STANDARD_NAME
})

function standardPolicy(): AgentPolicy | null {
  return store.policies.find((p) => p.name === STANDARD_NAME) ?? null
}

function selectPolicy(policy: AgentPolicy): void {
  selectedId.value = policy.id
  Object.assign(form, policyToForm(policy))
  formError.value = null
}

/** "New policy" starts from Standard's values — every threshold, ladder,
 *  contact and permission the same, only the name and id cleared. */
function startNewPolicy(): void {
  selectedId.value = null
  const std = standardPolicy()
  Object.assign(form, std ? policyToForm(std) : blankForm(), { id: null, name: '' })
  formError.value = null
}

// --- Shadow / Live -----------------------------------------------------------

const isGoLiveConfirmOpen = ref(false)
const GO_LIVE_SENTENCE = 'Live — the agent will text and call drivers and email you.'

function chooseShadow(): void {
  form.shadow = true
}

function chooseLive(): void {
  if (form.shadow) {
    // Going from shadow to live is a real change in what the agent is
    // allowed to do — confirm before the flip actually lands, and repeat
    // the sentence so nobody flips it by habit.
    isGoLiveConfirmOpen.value = true
    return
  }
}

function confirmGoLive(): void {
  form.shadow = false
  isGoLiveConfirmOpen.value = false
}

// --- Save / delete -------------------------------------------------------

const isSubmitting = ref(false)
const formError = ref<string | null>(null)
const isDeleteConfirmOpen = ref(false)
const isDeleting = ref(false)

function formToInput(): AgentPolicyInput {
  return {
    id: form.id ?? undefined,
    name: form.name,
    stopMin: form.stopMin,
    delayMin: form.delayMin,
    darkMin: form.darkMin,
    darkAtStopMin: form.darkAtStopMin,
    offRouteMi: form.offRouteMi,
    offRouteMin: form.offRouteMin,
    rungGapMin: form.rungGapMin,
    maxCalls: form.maxCalls,
    dispatcherEmail: form.dispatcherEmail,
    dispatcherPhone: form.dispatcherPhone.trim() ? form.dispatcherPhone.trim() : null,
    customerEmailOn: form.customerEmailOn,
    shadow: form.shadow,
    bossCallOn: form.bossCallOn,
    quietFrom: form.quietFrom.trim() ? form.quietFrom.trim() : null,
    quietTo: form.quietTo.trim() ? form.quietTo.trim() : null,
  }
}

async function handleSubmit(): Promise<void> {
  isSubmitting.value = true
  formError.value = null
  try {
    const saved = await store.savePolicy(formToInput())
    selectedId.value = saved.id
  } catch {
    formError.value = store.error
  } finally {
    isSubmitting.value = false
  }
}

function openDeleteConfirm(): void {
  isDeleteConfirmOpen.value = true
}

async function handleDelete(): Promise<void> {
  if (!form.id) return
  isDeleting.value = true
  try {
    await store.deletePolicy(form.id)
    isDeleteConfirmOpen.value = false
    startNewPolicy()
    const std = standardPolicy()
    if (std) selectPolicy(std)
  } catch {
    // store.error already reflects the refusal (e.g. "N loads still use
    // this policy"); surfaced via the banner below.
    isDeleteConfirmOpen.value = false
  } finally {
    isDeleting.value = false
  }
}

function loadsOn(policyId: string): number {
  return store.loadsByPolicy[policyId] ?? 0
}

onMounted(async () => {
  await resolveInitialTab()
  await store.loadPolicies()
  const std = standardPolicy()
  if (std) selectPolicy(std)
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-ink">Night Shift</h1>
      <p v-if="activeTab === 'policies'" class="mt-2 max-w-3xl text-sm leading-relaxed text-ink-2">
        The night shift agent watches a truck through the night on your behalf — it checks in on stops, flags delays,
        and calls or texts the driver when something looks off, then briefs you in the morning. How hard it pushes is a
        <strong class="text-ink">policy</strong>, configured once here and reused across your loads. Every policy starts
        in <strong class="text-ink">shadow</strong> — watch only: the agent plans what it would say and logs it, but
        sends nothing to anyone — until you decide it has earned trust and switch it to live.
      </p>
    </div>

    <div class="flex gap-2 border-b border-line" data-testid="night-shift-tabs">
      <button
        type="button"
        data-testid="tab-connect"
        class="border-b-2 px-3 py-2 text-sm font-medium"
        :class="activeTab === 'connect' ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink'"
        @click="activeTab = 'connect'"
      >
        Connect
      </button>
      <button
        type="button"
        data-testid="tab-policies"
        class="border-b-2 px-3 py-2 text-sm font-medium"
        :class="activeTab === 'policies' ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink'"
        @click="activeTab = 'policies'"
      >
        Policies
      </button>
    </div>

    <ConnectSheet v-if="activeTab === 'connect'" />

    <p v-else-if="activeTab === 'usage' || activeTab === 'settings'" class="text-sm text-ink-2" data-testid="coming-next">
      Coming next — {{ activeTab === 'usage' ? 'usage' : 'settings' }} lands in the next plan.
    </p>

    <template v-else>
    <p v-if="store.error" class="text-sm text-red-600" role="alert" data-testid="night-shift-error">
      {{ store.error }}
    </p>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
      <!-- Policy list -->
      <div class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold text-ink">Policies</h2>
          <AppButton type="button" variant="ghost" data-testid="new-policy" @click="startNewPolicy">New policy</AppButton>
        </div>

        <ul class="flex flex-col gap-1" data-testid="policy-list">
          <li v-for="policy in store.policies" :key="policy.id">
            <button
              type="button"
              class="flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left"
              :class="policy.id === selectedId ? 'border-brand bg-brand/10' : 'border-transparent hover:bg-surface-2'"
              :data-testid="`policy-row-${policy.id}`"
              @click="selectPolicy(policy)"
            >
              <span class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium text-ink">{{ policy.name }}</span>
                <span
                  class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ring-1"
                  :class="policy.shadow
                    ? 'bg-sky-500/10 text-sky-600 ring-sky-500/30 dark:text-sky-400'
                    : 'bg-red-500/10 text-red-600 ring-red-500/30 dark:text-red-400'"
                >
                  {{ policy.shadow ? 'SHADOW' : 'LIVE' }}
                </span>
              </span>
              <span class="text-xs text-ink-3">{{ loadsOn(policy.id) }} load{{ loadsOn(policy.id) === 1 ? '' : 's' }}</span>
            </button>
          </li>
        </ul>

        <p v-if="!store.loading && store.policies.length === 0" class="text-xs text-ink-3" data-testid="policy-list-empty">
          No policies yet.
        </p>
      </div>

      <!-- Editor -->
      <form class="flex flex-col gap-6 rounded-xl border border-line bg-surface p-5" @submit.prevent="handleSubmit">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-sm font-semibold text-ink">{{ isNew ? 'New policy' : form.name || 'Policy' }}</h2>
            <p class="mt-0.5 text-xs text-ink-3">Grouped the way a dispatcher thinks about the night shift.</p>
          </div>
          <AppButton
            v-if="!isNew && !isSelectedStandard"
            type="button"
            variant="danger"
            data-testid="delete-policy"
            @click="openDeleteConfirm"
          >
            Delete
          </AppButton>
        </div>

        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium text-ink-2">Policy name</span>
          <input
            id="policy-name"
            v-model="form.name"
            type="text"
            required
            maxlength="40"
            class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </label>

        <!-- Thresholds -->
        <fieldset class="flex flex-col gap-3">
          <legend class="text-xs font-semibold uppercase tracking-widest text-ink-3">Thresholds</legend>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-ink-2">Ask the driver after <input id="policy-stop-min" v-model.number="form.stopMin" type="number" min="1" max="240" required class="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" /> minutes stopped</span>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-ink-2">Flag a delay after <input id="policy-delay-min" v-model.number="form.delayMin" type="number" min="1" max="600" required class="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" /> minutes behind schedule</span>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-ink-2">Escalate after <input id="policy-dark-min" v-model.number="form.darkMin" type="number" min="1" max="600" required class="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" /> minutes without a location update</span>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-ink-2">Escalate after <input id="policy-dark-at-stop-min" v-model.number="form.darkAtStopMin" type="number" min="1" max="600" required class="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" /> minutes dark while stopped</span>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-ink-2">Flag when the truck strays <input id="policy-off-route-mi" v-model.number="form.offRouteMi" type="number" min="0.1" max="50" step="0.1" required class="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" /> miles off route</span>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-ink-2">...for at least <input id="policy-off-route-min" v-model.number="form.offRouteMin" type="number" min="1" max="120" required class="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" /> minutes before flagging it</span>
            </label>
          </div>
        </fieldset>

        <!-- Ladder -->
        <fieldset class="flex flex-col gap-3">
          <legend class="text-xs font-semibold uppercase tracking-widest text-ink-3">Ladder</legend>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-ink-2">Wait <input id="policy-rung-gap-min" v-model.number="form.rungGapMin" type="number" min="1" max="60" required class="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" /> minutes between each escalation step</span>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-ink-2">Call the driver up to <input id="policy-max-calls" v-model.number="form.maxCalls" type="number" min="0" max="5" required class="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" /> times before escalating</span>
            </label>
          </div>
        </fieldset>

        <!-- Contacts -->
        <fieldset class="flex flex-col gap-3">
          <legend class="text-xs font-semibold uppercase tracking-widest text-ink-3">Contacts</legend>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium text-ink-2">Who gets the escalation email</span>
              <input
                id="policy-dispatcher-email"
                v-model="form.dispatcherEmail"
                type="email"
                required
                class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium text-ink-2">Ring this number with a spoken briefing</span>
              <input
                id="policy-dispatcher-phone"
                v-model="form.dispatcherPhone"
                type="tel"
                placeholder="+15551234567"
                pattern="^\+\d{8,15}$"
                class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <span class="text-xs text-ink-3">Optional — leave blank to skip the briefing call.</span>
            </label>
          </div>
          <label class="flex items-center gap-3 text-sm">
            <button
              type="button"
              role="switch"
              :aria-checked="form.customerEmailOn"
              data-testid="toggle-customer-email"
              class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
              :class="form.customerEmailOn ? 'bg-brand' : 'bg-surface-3'"
              @click="form.customerEmailOn = !form.customerEmailOn"
            >
              <span class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform" :class="form.customerEmailOn ? 'translate-x-4' : 'translate-x-1'" />
            </button>
            <span class="text-ink-2">Also email the customer a status update</span>
          </label>
        </fieldset>

        <!-- Permissions -->
        <fieldset class="flex flex-col gap-3">
          <legend class="text-xs font-semibold uppercase tracking-widest text-ink-3">Permissions</legend>

          <div class="flex flex-col gap-2" data-testid="shadow-live-toggle">
            <button
              type="button"
              data-testid="choose-shadow"
              class="rounded-lg border p-3 text-left text-sm"
              :class="form.shadow ? 'border-brand bg-brand/10' : 'border-line hover:bg-surface-2'"
              @click="chooseShadow"
            >
              <span class="font-semibold text-ink">Shadow</span>
              <span class="text-ink-2"> — watch only. The agent plans and logs what it would say; nothing is sent.</span>
            </button>
            <button
              type="button"
              data-testid="choose-live"
              class="rounded-lg border p-3 text-left text-sm"
              :class="!form.shadow ? 'border-red-500 bg-red-500/10' : 'border-line hover:bg-surface-2'"
              @click="chooseLive"
            >
              <span class="font-semibold text-ink">Live</span>
              <span class="text-ink-2"> — the agent texts and calls drivers and emails you.</span>
            </button>
          </div>

          <label class="flex items-center gap-3 text-sm">
            <button
              type="button"
              role="switch"
              :aria-checked="form.bossCallOn"
              data-testid="toggle-boss-call"
              class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
              :class="form.bossCallOn ? 'bg-brand' : 'bg-surface-3'"
              @click="form.bossCallOn = !form.bossCallOn"
            >
              <span class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform" :class="form.bossCallOn ? 'translate-x-4' : 'translate-x-1'" />
            </button>
            <span class="text-ink-2">Allow a boss call when the agent can't reach the driver</span>
          </label>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium text-ink-2">Quiet hours — from</span>
              <input
                id="policy-quiet-from"
                v-model="form.quietFrom"
                type="time"
                class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium text-ink-2">Quiet hours — to</span>
              <input
                id="policy-quiet-to"
                v-model="form.quietTo"
                type="time"
                class="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </label>
          </div>
          <p class="text-xs text-ink-3">Leave both blank to allow calls and texts at any hour.</p>
        </fieldset>

        <p v-if="formError" class="text-sm text-red-600" role="alert" data-testid="form-error">{{ formError }}</p>

        <div class="flex justify-end gap-2 border-t border-line pt-4">
          <AppButton type="submit" :loading="isSubmitting" data-testid="save-policy">{{ isNew ? 'Create policy' : 'Save' }}</AppButton>
        </div>
      </form>
    </div>

    <!-- Go-live confirmation -->
    <Modal v-model:open="isGoLiveConfirmOpen">
      <template #header>
        <h2 class="text-lg font-semibold text-ink">Switch this policy to live?</h2>
      </template>
      <p class="text-sm text-ink-2" data-testid="go-live-sentence">{{ GO_LIVE_SENTENCE }}</p>
      <template #footer>
        <AppButton type="button" variant="ghost" @click="isGoLiveConfirmOpen = false">Cancel</AppButton>
        <AppButton type="button" variant="danger" data-testid="confirm-go-live" @click="confirmGoLive">Go live</AppButton>
      </template>
    </Modal>

    <!-- Delete confirmation -->
    <Modal v-model:open="isDeleteConfirmOpen">
      <template #header>
        <h2 class="text-lg font-semibold text-ink">Delete "{{ form.name }}"?</h2>
      </template>
      <p class="text-sm text-ink-2">Loads on this policy must be moved first — deleting fails if any load still uses it.</p>
      <template #footer>
        <AppButton type="button" variant="ghost" @click="isDeleteConfirmOpen = false">Cancel</AppButton>
        <AppButton type="button" variant="danger" :loading="isDeleting" data-testid="confirm-delete-policy" @click="handleDelete">Delete</AppButton>
      </template>
    </Modal>
    </template>
  </div>
</template>

<script setup lang="ts">
import { provide, ref } from 'vue'
import { useRouter } from 'vue-router'
import AgentDrawer from '../../components/agent/AgentDrawer.vue'
import { linkApi } from '../api/linkApi'

// Task 10 (the deep link): the page a phone lands on from a status cell's
// note URL or an escalation SMS/email — ${PORTAL_URL}/n/:orgToken/:loadId
// (nightShiftLink.ts's linkUrlFor, backend). Route `/n/:orgToken/:loadId`
// (router/index.ts) is `meta: { public: true }`, so it never runs into the
// dispatcher auth guard, and it is a top-level route, not an AppShell child —
// there is no sidebar, no board, nothing else on the page.
//
// The drawer supervises this load through the token, never a bearer:
// `provide('nightShiftApi', linkApi(orgToken))` overrides the default
// dispatcher-store transport AgentDrawer.vue injects, so every fetch and
// every command it posts goes to /api/n/:orgToken/... with no
// Authorization header at all — see nightshift/api/linkApi.ts.
const props = defineProps<{ orgToken: string; loadId: string }>()

provide('nightShiftApi', linkApi(props.orgToken))

// Fix round 1: AgentDrawer's ✕ emits `close`, which every other mount
// (BrokerBoardView, CockpitView) handles by hiding the drawer — there is
// nothing else on THIS page to fall back to. On a phone opened from an SMS
// or a sheet note, "close" means "leave": go back in history if this tab
// has somewhere to go back to, otherwise try to close the tab outright. A
// browser refuses `window.close()` on a tab it did not open with script
// (true for essentially every real case here — a link tapped in Messages or
// Gmail opens a fresh tab with no history), and that refusal is silent, so
// the fallback is a real UI state rather than a click that appears to do
// nothing.
const router = useRouter()
const closed = ref(false)
function handleClose(): void {
  if (window.history.length > 1) {
    router.back()
    return
  }
  window.close()
  closed.value = true
}
</script>

<template>
  <div class="flex h-screen w-full flex-col overflow-hidden bg-surface" data-testid="night-shift-link-view">
    <!-- AgentDrawer's own header already carries LOAD# and the shadow/policy
         pill (spec's "minimal header (LOAD#, pill)") — it renders as a
         `fixed inset-y-0 right-0 w-full max-w-[440px]` panel, which at a
         phone's width (390px, under the 440px cap) simply fills the
         viewport: no separate outer header needed, and nothing here adds a
         second one that would just duplicate it. No `load-no` is passed
         (final fix wave, minor): there is no board row here to take it
         from, so the drawer shows the timeline's own `boardLoadNo` — the
         sheet's LOAD# — and only falls back to the uuid when the load never
         carried one. -->
    <AgentDrawer v-if="!closed" :load-id="loadId" @close="handleClose" />
    <p v-else class="flex flex-1 items-center justify-center p-6 text-center text-sm text-ink-2" data-testid="link-closed-message">
      You can close this tab.
    </p>
  </div>
</template>

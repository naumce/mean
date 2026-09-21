<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { subscribe } from '../lib/realtime'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'
import SidebarNavItem from './SidebarNavItem.vue'
import DemoTimeShift from '../components/demo/DemoTimeShift.vue'

const auth = useAuthStore()
const theme = useThemeStore()
const router = useRouter()
const route = useRoute()
const moreOpen = ref(false)

// M5 (ruling A4-R14): hold one subscription for the life of the signed-in
// session, here in the shell that wraps every authenticated route. Vue
// unmounts the outgoing view before mounting the incoming one, so if only
// the per-view stores subscribed (loadLocks/brokerBoard/loadboard), the
// handler count would hit zero on every navigation and lib/realtime.ts would
// close the shared socket between them — and the server's close path
// releases this dispatcher's held load locks and broadcasts `load_unlock`
// for each one. `$session` is a type no store's frame handler reads; this
// subscription exists only to keep at least one handler registered for as
// long as the shell is mounted, so the socket's lifetime matches what it
// actually models: a signed-in tab, not whichever view happens to be
// showing. No grace-period timer — that would make correctness depend on
// winning a race between an unmount and a mount instead of just not letting
// the count reach zero in the first place.
let releaseSession: (() => void) | null = null
onMounted(() => { releaseSession = subscribe('$session', () => {}) })
onUnmounted(() => { releaseSession?.(); releaseSession = null })

const TOWER_PRIMARY = [
  { label: 'Their Board', to: '/board/broker', icon: 'tower' },
  { label: 'Control Tower', to: '/cockpit', icon: 'tower' },
  { label: 'Night Shift', to: '/night-shift', icon: 'tower' },
  { label: 'Import', to: '/import', icon: 'import' },
  { label: 'Analytics', to: '/brokers', icon: 'chart' },
  { label: 'Money', to: '/money', icon: 'money' },
  { label: 'Fleet', to: '/fleet', icon: 'fleet' },
]
const TOWER_MORE = [
  { label: 'Messages', to: '/messages' },
  { label: 'Tracking', to: '/tracking' },
  { label: 'Approvals', to: '/approvals' },
  { label: 'Drivers', to: '/drivers' },
  { label: 'Vehicles', to: '/vehicles' },
  { label: 'Trips', to: '/trips' },
  { label: 'Board', to: '/board' },
  { label: 'Overview', to: '/overview' },
]
// Sheet-tier nav (Night Shift packaged as a Google Sheet plugin, not the
// full Cockpit product): exactly these four, in this order, nothing in
// "More". Usage/Settings are placeholders — NightShiftView (Task 11) reads
// `?tab=` and shows a one-line "Coming next" panel for both; a later
// increment gives them real content.
const SHEET_NAV = [
  { label: 'Board', to: '/board/broker' },
  { label: 'Night Shift', to: '/night-shift' },
  { label: 'Usage', to: '/night-shift?tab=usage' },
  { label: 'Settings', to: '/night-shift?tab=settings' },
]

const primaryNav = computed(() => (auth.tier === 'sheet' ? SHEET_NAV : TOWER_PRIMARY))
const moreNav = computed(() => (auth.tier === 'sheet' ? [] : TOWER_MORE))

const initials = computed(() => {
  const n = auth.dispatcher?.name ?? 'D'
  return n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
})
const isMoreActive = computed(() => moreNav.value.some((i) => route.path.startsWith(i.to)))

async function handleLogout(): Promise<void> {
  auth.logout()
  await router.push('/login')
}
</script>

<template>
  <div class="flex h-full min-h-screen bg-bg text-ink">
    <aside class="flex w-[248px] flex-shrink-0 flex-col border-r border-line bg-surface">
      <div class="flex items-center gap-3 border-b border-line px-4 py-4">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary-600 to-blue-700 text-sm font-bold text-white shadow-sm">F</div>
        <div class="flex flex-col">
          <span class="text-[13px] font-bold leading-none tracking-tight text-ink">Fleet Dispatch</span>
          <span class="text-[11px] font-medium tracking-wide text-brand-ink">CONTROL TOWER</span>
        </div>
        <span class="ml-auto flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400">
          <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span> LIVE
        </span>
      </div>

      <nav class="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        <div>
          <p class="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-ink-3">Operate</p>
          <div class="flex flex-col gap-1">
            <SidebarNavItem v-for="item in primaryNav" :key="item.label" :label="item.label" :to="item.to" :disabled="false" />
          </div>
        </div>

        <!-- Only renders on a server running DEMO_MODE — the endpoint 404s
             otherwise, so there is no second flag here to drift out of sync. -->
        <DemoTimeShift />

        <div v-if="moreNav.length > 0">
          <button
            type="button"
            class="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium hover:bg-surface-2"
            :class="isMoreActive ? 'bg-surface-2 text-ink' : 'text-ink-3'"
            :aria-expanded="moreOpen"
            data-testid="nav-more-toggle"
            @click="moreOpen = !moreOpen"
          >
            <span class="flex items-center gap-2">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
              More
            </span>
            <svg class="h-3 w-3 transition-transform" :class="moreOpen ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <div v-if="moreOpen" class="mt-1 flex flex-col gap-0.5 border-l-2 border-line pl-2">
            <SidebarNavItem v-for="item in moreNav" :key="item.label" :label="item.label" :to="item.to" :disabled="false" />
          </div>
        </div>
      </nav>
    </aside>

    <div class="flex flex-1 flex-col min-w-0">
      <header class="flex items-center justify-between border-b border-line bg-surface/80 px-6 py-3 backdrop-blur">
        <div class="flex items-center gap-3">
          <div class="hidden sm:flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-2">
            <span class="h-2 w-2 rounded-full bg-brand"></span>
            Dispatcher Portal
            <span class="text-ink-3">·</span>
            <span class="text-ink">{{ route.path === '/cockpit' ? 'Control Tower' : route.path.slice(1) || 'home' }}</span>
          </div>
          <span class="sm:hidden text-sm font-semibold text-ink-2">Dispatcher Portal</span>
        </div>
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
            :title="theme.isDark ? 'Switch to light mode' : 'Switch to dark mode'"
            :aria-label="theme.isDark ? 'Switch to light mode' : 'Switch to dark mode'"
            data-testid="theme-toggle"
            @click="theme.toggle()"
          >
            {{ theme.isDark ? '☀' : '◐' }}
          </button>
          <div class="hidden sm:flex items-center gap-2">
            <div class="h-7 w-7 rounded-full bg-ink text-bg flex items-center justify-center text-xs font-bold">{{ initials }}</div>
            <span class="text-sm font-medium text-ink">{{ auth.dispatcher?.name ?? 'Dispatcher' }}</span>
          </div>
          <button
            type="button"
            class="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-2 hover:bg-surface-2"
            @click="handleLogout"
          >
            Logout
          </button>
        </div>
      </header>

      <main class="flex-1 p-4 sm:p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>

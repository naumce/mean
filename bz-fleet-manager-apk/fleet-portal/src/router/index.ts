import type { RouteLocationRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'
import AppShell from '../layouts/AppShell.vue'
import AgentsView from '../views/AgentsView.vue'
import ApprovalsView from '../views/ApprovalsView.vue'
import AiLabView from '../views/ai/AiLabView.vue'
import AiExperimentView from '../views/ai/AiExperimentView.vue'
import AiRunView from '../views/ai/AiRunView.vue'
import BoardView from '../views/BoardView.vue'
import BrokerBoardView from '../views/BrokerBoardView.vue'
import BrokersView from '../views/BrokersView.vue'
import CockpitView from '../views/CockpitView.vue'
import ImportView from '../views/ImportView.vue'
import DashboardView from '../views/DashboardView.vue'
import DemoView from '../views/DemoView.vue'
import DriversView from '../views/DriversView.vue'
import DriverSupplyView from '../views/DriverSupplyView.vue'
import LoginView from '../views/LoginView.vue'
import SignupView from '../views/SignupView.vue'
import NightShiftLinkView from '../nightshift/views/NightShiftLinkView.vue'
import MessagesView from '../views/MessagesView.vue'
import MoneyView from '../views/MoneyView.vue'
import FleetView from '../views/FleetView.vue'
import NightShiftView from '../views/NightShiftView.vue'
import TrackingView from '../views/TrackingView.vue'
import TripDetailView from '../views/TripDetailView.vue'
import TripsView from '../views/TripsView.vue'
import VehiclesView from '../views/VehiclesView.vue'
import { useAuthStore } from '../stores/auth'
import { authGuard } from './guards'

export const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { public: true },
  },
  {
    path: '/signup',
    name: 'signup',
    component: SignupView,
    meta: { public: true },
  },
  // Task 10 (the deep link): a phone opening a status cell's note URL or an
  // escalation SMS/email — no dispatcher session at all. Public, top-level
  // (like /login above), never a child of AppShell — no sidebar.
  {
    path: '/n/:orgToken/:loadId',
    name: 'night-shift-link',
    component: NightShiftLinkView,
    meta: { public: true },
    props: true,
  },
  {
    path: '/',
    component: AppShell,
    children: [
      // The Control Tower is the product — it owns the landing route. The
      // legacy trip-stats dashboard lives on at /overview. Sheet-tier
      // sessions (Night Shift packaged as a Google Sheet plugin) have no
      // Cockpit in their nav, so '/' sends them to the broker board instead.
      // A `redirect` function (not `beforeEnter`) reads the store: Pinia is
      // installed before the router in main.ts, and the existing auth guard
      // (./guards.ts) already reads `useAuthStore()` on every navigation, so
      // it is guaranteed active by the time either runs.
      {
        path: '',
        redirect: (): RouteLocationRaw =>
          (useAuthStore().tier === 'sheet' ? { name: 'broker-board' } : { name: 'cockpit' }),
      },
      { path: 'cockpit', name: 'cockpit', component: CockpitView },
      // AI Agents Surface (2026-09-30 plan, Task 4): "AI Agents" — what the
      // Dispatch Assistant and Night Shift can each do right now.
      { path: 'agents', name: 'agents', component: AgentsView },
      // Demo Mode (2026-09-28 plan): the presenter screen — 404s server-side
      // unless DEMO_MODE is on; the nav entry (AppShell's TOWER_PRIMARY)
      // hides itself the same way, off stores/demo.ts's probe().
      { path: 'demo', name: 'demo', component: DemoView },
      { path: 'overview', name: 'dashboard', component: DashboardView },
      { path: 'board/broker', name: 'broker-board', component: BrokerBoardView },
      { path: 'board', name: 'board', component: BoardView },
      // The Slice-1 board lived here; the Cockpit is the Control Tower now.
      { path: 'loadboard', redirect: { name: 'cockpit' } },
      { path: 'night-shift', name: 'night-shift', component: NightShiftView },
      { path: 'import', name: 'import', component: ImportView },
      { path: 'brokers', name: 'brokers', component: BrokersView },
      { path: 'money', name: 'money', component: MoneyView },
      { path: 'fleet', name: 'fleet', component: FleetView },
      { path: 'drivers', name: 'drivers', component: DriversView },
      // AI Dispatch Foundation (Task 9): Driver Supply — every driver's
      // status, location, load, HOS, equipment and preferences.
      { path: 'supply', name: 'driver-supply', component: DriverSupplyView },
      // Qwen Harness v0.1 (Task 7): the AI Lab developer console — read-only
      // dispatch reasoning, tower tier only (see AppShell's TOWER_MORE).
      { path: 'ai-lab', name: 'ai-lab', component: AiLabView },
      { path: 'ai-lab/experiments/:id', name: 'ai-experiment', component: AiExperimentView, props: true },
      { path: 'ai-lab/runs/:id', name: 'ai-run', component: AiRunView, props: true },
      { path: 'vehicles', name: 'vehicles', component: VehiclesView },
      { path: 'trips', name: 'trips', component: TripsView },
      { path: 'trips/:id', name: 'trip-detail', component: TripDetailView, props: true },
      { path: 'approvals', name: 'approvals', component: ApprovalsView },
      { path: 'messages', name: 'messages', component: MessagesView },
      { path: 'tracking', name: 'tracking', component: TrackingView },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(authGuard)

export default router

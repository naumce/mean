import { createRouter, createWebHistory } from 'vue-router'
import AppShell from '../layouts/AppShell.vue'
import DashboardView from '../views/DashboardView.vue'
import DriversView from '../views/DriversView.vue'
import LoginView from '../views/LoginView.vue'
import TripDetailView from '../views/TripDetailView.vue'
import TripsView from '../views/TripsView.vue'
import VehiclesView from '../views/VehiclesView.vue'
import { authGuard } from './guards'

export const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { public: true },
  },
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', name: 'dashboard', component: DashboardView },
      { path: 'drivers', name: 'drivers', component: DriversView },
      { path: 'vehicles', name: 'vehicles', component: VehiclesView },
      { path: 'trips', name: 'trips', component: TripsView },
      { path: 'trips/:id', name: 'trip-detail', component: TripDetailView, props: true },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(authGuard)

export default router

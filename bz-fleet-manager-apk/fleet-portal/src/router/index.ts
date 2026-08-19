import { createRouter, createWebHistory } from 'vue-router'
import AppShell from '../layouts/AppShell.vue'
import DashboardView from '../views/DashboardView.vue'
import DriversView from '../views/DriversView.vue'
import LoginView from '../views/LoginView.vue'
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
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(authGuard)

export default router

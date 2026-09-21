import type { NavigationGuardWithThis } from 'vue-router'
import { useAuthStore } from '../stores/auth'

// Routes opt into being public via `meta: { public: true }` (/login and
// /signup). Everything else requires an authenticated dispatcher.
export const authGuard: NavigationGuardWithThis<undefined> = (to) => {
  const auth = useAuthStore()
  const isPublic = to.meta.public === true

  if (!isPublic && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if ((to.name === 'login' || to.name === 'signup') && auth.isAuthenticated) {
    return { path: '/' }
  }

  return true
}

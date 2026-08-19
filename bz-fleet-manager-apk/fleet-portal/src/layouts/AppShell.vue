<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import SidebarNavItem from './SidebarNavItem.vue'

const auth = useAuthStore()
const router = useRouter()

const navItems = [
  { label: 'Dashboard', to: '/', disabled: false },
  { label: 'Drivers', disabled: true },
  { label: 'Vehicles', disabled: true },
  { label: 'Trips', disabled: true },
  { label: 'Approvals', disabled: true },
  { label: 'Messages', disabled: true },
]

async function handleLogout(): Promise<void> {
  auth.logout()
  await router.push('/login')
}
</script>

<template>
  <div class="flex h-full min-h-screen bg-gray-50">
    <aside class="flex w-60 flex-shrink-0 flex-col border-r border-gray-200 bg-white">
      <div class="flex items-center gap-2 border-b border-gray-200 px-4 py-4">
        <div class="flex h-8 w-8 items-center justify-center rounded-md bg-primary-600 text-sm font-bold text-white">
          F
        </div>
        <span class="text-sm font-semibold text-gray-900">Fleet Dispatch</span>
      </div>
      <nav class="flex flex-1 flex-col gap-1 p-3">
        <SidebarNavItem
          v-for="item in navItems"
          :key="item.label"
          :label="item.label"
          :to="item.to"
          :disabled="item.disabled"
        />
      </nav>
    </aside>

    <div class="flex flex-1 flex-col">
      <header class="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
        <div class="text-sm font-medium text-gray-500">Dispatcher Portal</div>
        <div class="flex items-center gap-4">
          <span class="text-sm font-medium text-gray-700">{{ auth.dispatcher?.name ?? 'Dispatcher' }}</span>
          <button
            type="button"
            class="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
            @click="handleLogout"
          >
            Logout
          </button>
        </div>
      </header>

      <main class="flex-1 p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>

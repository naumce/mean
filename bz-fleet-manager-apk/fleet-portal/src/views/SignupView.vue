<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const orgName = ref('')
const name = ref('')
const email = ref('')
const password = ref('')
const timezone = ref('America/Chicago')
const isSubmitting = ref(false)

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
]

async function handleSubmit(): Promise<void> {
  isSubmitting.value = true
  try {
    await auth.signup({
      orgName: orgName.value,
      name: name.value,
      email: email.value,
      password: password.value,
      timezone: timezone.value,
      // Only ever send "nightshift" explicitly; any other/missing query
      // value is left off the body so the server's own default (tower)
      // applies — it decides what "default" means, not this form.
      ...(route.query.product === 'nightshift' ? { product: 'nightshift' as const } : {}),
    })
    // Push to '/', not a hardcoded '/cockpit': the store now has this
    // session's `plan` from the signup response (auth.signup persists it
    // the same way login does), and the router's tier-aware redirect on
    // '/' (src/router/index.ts) sends a sheet-tier signup to the broker
    // board and a tower-tier one to the cockpit. Hardcoding '/cockpit' here
    // would land a `?product=nightshift` signup on the very page this
    // tier's nav hides.
    await router.push('/')
  } catch {
    // auth.error already holds a user-facing message; nothing else to do.
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-50 px-4">
    <div class="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
      <div class="mb-6 flex flex-col items-center gap-2">
        <div class="flex h-10 w-10 items-center justify-center rounded-md bg-primary-600 text-lg font-bold text-white">
          F
        </div>
        <h1 class="text-lg font-semibold text-gray-900">Create your fleet</h1>
        <p class="text-sm text-gray-500">Set up your company and dispatcher account</p>
      </div>

      <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
        <div class="flex flex-col gap-1">
          <label for="orgName" class="text-sm font-medium text-gray-700">Company name</label>
          <input
            id="orgName"
            v-model="orgName"
            type="text"
            autocomplete="organization"
            required
            minlength="2"
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="name" class="text-sm font-medium text-gray-700">Your name</label>
          <input
            id="name"
            v-model="name"
            type="text"
            autocomplete="name"
            required
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="email" class="text-sm font-medium text-gray-700">Email</label>
          <input
            id="email"
            v-model="email"
            type="email"
            autocomplete="username"
            required
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="password" class="text-sm font-medium text-gray-700">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
          <p class="text-xs text-gray-500">At least 8 characters</p>
        </div>

        <div class="flex flex-col gap-1">
          <label for="timezone" class="text-sm font-medium text-gray-700">Time zone</label>
          <select
            id="timezone"
            v-model="timezone"
            class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          >
            <option v-for="tz in TIMEZONES" :key="tz.value" :value="tz.value">{{ tz.label }}</option>
          </select>
        </div>

        <p v-if="auth.error" class="text-sm text-red-600" role="alert">
          {{ auth.error }}
        </p>

        <button
          type="submit"
          :disabled="isSubmitting"
          class="mt-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {{ isSubmitting ? 'Creating account…' : 'Create account' }}
        </button>
      </form>

      <p class="mt-4 text-center text-sm text-gray-500">
        Already have an account?
        <RouterLink to="/login" class="font-medium text-primary-600 hover:text-primary-700">Sign in</RouterLink>
      </p>
    </div>
  </div>
</template>

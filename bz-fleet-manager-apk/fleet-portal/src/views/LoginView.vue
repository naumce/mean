<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()

const email = ref('')
const password = ref('')
const isSubmitting = ref(false)

async function handleSubmit(): Promise<void> {
  isSubmitting.value = true
  try {
    await auth.login(email.value, password.value)
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
        <h1 class="text-lg font-semibold text-gray-900">Fleet Dispatch</h1>
        <p class="text-sm text-gray-500">Sign in to the dispatcher portal</p>
      </div>

      <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
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
            autocomplete="current-password"
            required
            class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-600 focus:outline-none focus:ring-1 focus:ring-primary-600"
          />
        </div>

        <p v-if="auth.error" class="text-sm text-red-600" role="alert">
          {{ auth.error }}
        </p>

        <button
          type="submit"
          :disabled="isSubmitting"
          class="mt-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {{ isSubmitting ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </div>
  </div>
</template>

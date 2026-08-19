<script setup lang="ts">
// v-model:open controlled modal. Teleports to <body> so it isn't clipped by
// an ancestor's overflow/z-index, closes on ESC or backdrop click, and does
// a basic focus trap by moving focus into the dialog when it opens.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const open = defineModel<boolean>('open', { required: true })

const dialogRef = ref<HTMLElement | null>(null)

function close(): void {
  open.value = false
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) close()
}

watch(open, async (isOpen) => {
  if (isOpen) {
    await nextTick()
    dialogRef.value?.focus()
  }
})

onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="fixed inset-0 bg-gray-900/50" @click="close" />
      <div
        ref="dialogRef"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        class="relative flex max-h-full w-full max-w-md flex-col gap-4 overflow-y-auto rounded-lg bg-white p-6 shadow-lg focus:outline-none"
      >
        <div class="flex items-center justify-between">
          <slot name="header" />
          <button
            type="button"
            aria-label="Close"
            class="text-gray-400 hover:text-gray-600"
            @click="close"
          >
            ✕
          </button>
        </div>

        <div><slot /></div>

        <div v-if="$slots.footer" class="flex justify-end gap-2">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'ghost' | 'danger'
    type?: 'button' | 'submit'
    loading?: boolean
    disabled?: boolean
  }>(),
  { variant: 'primary', type: 'button', loading: false, disabled: false },
)

const variantClasses: Record<'primary' | 'ghost' | 'danger', string> = {
  primary: 'bg-primary-600 text-white hover:bg-primary-700',
  ghost: 'border border-gray-300 text-gray-700 hover:bg-gray-100',
  danger: 'bg-red-600 text-white hover:bg-red-700',
}
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    class="rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
    :class="variantClasses[props.variant]"
  >
    <slot v-if="!loading" />
    <span v-else>Loading…</span>
  </button>
</template>

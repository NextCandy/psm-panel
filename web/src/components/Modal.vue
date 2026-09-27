<script setup lang="ts">
// A dialog: the title, a scrolling body, the buttons at the foot. Escape or a
// click beside it closes it (unless `sticky`: a form half filled in), and the
// first field gets the focus.
import { nextTick, onMounted, onUnmounted, ref } from 'vue'

const props = withDefaults(defineProps<{ title: string; subtitle?: string; size?: 'narrow' | 'normal' | 'wide'; sticky?: boolean }>(),
  { subtitle: '', size: 'normal', sticky: false })
const emit = defineEmits<{ close: [] }>()
const box = ref<HTMLElement | null>(null)

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(async () => {
  document.addEventListener('keydown', onKey)
  await nextTick()
  box.value?.querySelector<HTMLElement>('input:not([disabled]):not([type=checkbox]), select:not([disabled]), textarea')?.focus()
})
onUnmounted(() => document.removeEventListener('keydown', onKey))
const outside = () => { if (!props.sticky) emit('close') }
</script>

<template>
  <div class="overlay" @click.self="outside">
    <div ref="box" class="dialog" :class="size" role="dialog" aria-modal="true" :aria-label="title">
      <div class="dialog-head">
        <div>
          <h2>{{ title }}</h2>
          <p v-if="subtitle">{{ subtitle }}</p>
          <slot name="subtitle" />
        </div>
        <slot name="head" />
      </div>
      <slot />
      <div v-if="$slots.foot" class="dialog-foot"><slot name="foot" /></div>
    </div>
  </div>
</template>

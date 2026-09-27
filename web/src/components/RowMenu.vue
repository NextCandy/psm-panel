<script setup lang="ts">
// A row's less frequent actions behind "⋯": items are the slot's buttons; a
// click anywhere else, or Escape, closes it.
import { onUnmounted, ref } from 'vue'
import Icon from './Icon.vue'

defineProps<{ test?: string }>()
const open = ref(false)
const wrap = ref<HTMLElement | null>(null)
function away(e: Event) {
  if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.value?.contains(e.target as Node)) close()
}
function toggle() {
  open.value = !open.value
  if (open.value) {
    setTimeout(() => { document.addEventListener('click', away); document.addEventListener('keydown', away) })
  } else close()
}
function close() {
  open.value = false
  document.removeEventListener('click', away)
  document.removeEventListener('keydown', away)
}
onUnmounted(close)
</script>

<template>
  <div ref="wrap" class="menu-wrap">
    <button class="btn icon small ghost" type="button" title="更多操作" :data-test="test" aria-haspopup="menu" @click.stop="toggle">
      <Icon name="more" />
    </button>
    <div v-if="open" class="menu" role="menu" @click="close"><slot /></div>
  </div>
</template>

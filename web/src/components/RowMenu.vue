<script setup lang="ts">
// A row's less frequent actions behind "⋯": items are the slot's buttons; a
// click anywhere else, or Escape, closes it. The menu is drawn on <body>,
// placed by the button (and kept there through a scroll or a resize): inside
// the table it was cut off by .table-wrap (a scroll container), the last rows'
// menus entirely.
import { nextTick, onUnmounted, ref } from 'vue'
import Icon from './Icon.vue'

defineProps<{ test?: string }>()
const open = ref(false)
const wrap = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0 })
function away(e: Event) {
  if (e instanceof KeyboardEvent) { if (e.key === 'Escape') close(); return }
  const t = e.target as Node
  if (!wrap.value?.contains(t) && !menu.value?.contains(t)) close()
}
// below the button, right edges lined up; above it when it does not fit below
// and there is more room above; in a window too short for either, moved up or
// down to stay inside it
function place() {
  if (!wrap.value || !menu.value) return
  const b = wrap.value.getBoundingClientRect()
  const w = menu.value.offsetWidth, h = menu.value.offsetHeight, gap = 4, edge = 8
  const below = innerHeight - edge - b.bottom - gap, above = b.top - gap - edge
  const top = h <= below || below >= above ? b.bottom + gap : b.top - gap - h
  pos.value = {
    top: Math.max(edge, Math.min(top, innerHeight - edge - h)),
    left: Math.max(edge, Math.min(b.right - w, innerWidth - w - edge)),
  }
}
// The listeners go on at once, not after a timeout: an Escape right after the
// click would find none and leave the menu open. The opening click itself
// never reaches them (@click.stop, and away() spares the button). A scroll
// moves the menu with its button rather than closing it: the scroll that
// brought the button into view often lands just after the click.
function toggle() {
  if (open.value) return close()
  open.value = true
  document.addEventListener('click', away)
  document.addEventListener('keydown', away)
  addEventListener('scroll', place, true)
  addEventListener('resize', place)
  nextTick(place)
}
function close() {
  open.value = false
  document.removeEventListener('click', away)
  document.removeEventListener('keydown', away)
  removeEventListener('scroll', place, true)
  removeEventListener('resize', place)
}
onUnmounted(close)
</script>

<template>
  <div ref="wrap" class="menu-wrap">
    <button class="btn icon small ghost" type="button" title="更多操作" :data-test="test" aria-haspopup="menu" :aria-expanded="open" @click.stop="toggle">
      <Icon name="more" />
    </button>
    <Teleport to="body">
      <div v-if="open" ref="menu" class="menu" role="menu" :style="{ top: `${pos.top}px`, left: `${pos.left}px` }" @click="close"><slot /></div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ command: string }>()
const copied = ref(false)
async function copy() {
  await navigator.clipboard.writeText(props.command)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <div class="cmd">
    <code data-test="install-command">{{ command }}</code>
    <button class="btn" type="button" @click="copy">{{ copied ? '已复制' : '复制' }}</button>
  </div>
</template>

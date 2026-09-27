<script setup lang="ts">
// The toasts and the confirmation dialog, mounted once for every page.
import { computed, ref, watch } from 'vue'
import { confirmState, dismiss, settleConfirm, toasts } from '../ui'
import Modal from './Modal.vue'

const typed = ref('')
watch(() => confirmState.open, (open) => { if (open) typed.value = '' })
const canConfirm = computed(() => !confirmState.opts.typed || typed.value.trim() === confirmState.opts.typed)
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind" data-test="toast">
      <span class="dot" /><span>{{ t.text }}</span>
      <button type="button" aria-label="关闭" @click="dismiss(t.id)">✕</button>
    </div>
  </div>
  <Modal v-if="confirmState.open" :title="confirmState.opts.title" size="narrow" @close="settleConfirm(false)">
    <div class="dialog-body" data-test="confirm">
      <p v-if="confirmState.opts.body" style="margin: 0; white-space: pre-line; line-height: 1.7">{{ confirmState.opts.body }}</p>
      <div v-if="confirmState.opts.typed" class="field" style="margin: 14px 0 0">
        <label>输入 <code>{{ confirmState.opts.typed }}</code> 确认</label>
        <input v-model="typed" class="input" data-test="confirm-typed" @keydown.enter="canConfirm && settleConfirm(true)">
      </div>
    </div>
    <template #foot>
      <button class="btn ghost" type="button" data-test="confirm-cancel" @click="settleConfirm(false)">取消</button>
      <button class="btn" :class="confirmState.opts.danger ? 'danger solid' : 'primary'" type="button" :disabled="!canConfirm"
              data-test="confirm-ok" @click="settleConfirm(true)">{{ confirmState.opts.ok ?? '确定' }}</button>
    </template>
  </Modal>
</template>

<script setup lang="ts">
// A node's link as it reaches clients through a relay: the node's own link
// with the relay's entry address and port (GET /api/relays/:id/link), masked
// until asked for, as the node's own link is.
import { onMounted, ref } from 'vue'
import { api, errorText, type Relay } from '../api'
import Modal from './Modal.vue'
import SecretText from './SecretText.vue'

const props = defineProps<{ relay: Relay; entry: string }>()
const emit = defineEmits<{ close: [] }>()
const link = ref<{ content: string; format: string; host: string; port: number } | null>(null)
const error = ref('')
onMounted(async () => {
  try {
    link.value = await api(`/api/relays/${props.relay.id}/link`)
  } catch (e) {
    error.value = errorText(e)
  }
})
</script>

<template>
  <Modal :title="`${entry}-${relay.name} 的${link?.format === 'surge' ? ' Surge 配置行' : '链接'}`"
         subtitle="节点的设置，入口的地址和端口：客户端经这条中转连到节点。" @close="emit('close')">
    <div class="dialog-body">
      <div v-if="error" class="notice warn" data-test="relay-link-error">{{ error }}</div>
      <template v-else-if="link">
        <SecretText :value="link.content" test="relay-link" copied="已复制链接" />
        <p class="help">连 <span class="mono">{{ link.host.includes(':') ? `[${link.host}]` : link.host }}:{{ link.port }}</span>{{ relay.status === 'applied' ? '' : '（中转还没运行，现在连不上）' }}。链接里有节点的密码，只发给要用它的人。</p>
      </template>
      <div v-else class="skeleton" style="height: 38px" />
    </div>
    <template #foot><button class="btn primary" type="button" @click="emit('close')">完成</button></template>
  </Modal>
</template>

<script setup lang="ts">
// The one-click install command. Its join token lets a machine join as this
// server, so the token is masked until asked for; copying needs no showing.
import { computed } from 'vue'
import SecretText from './SecretText.vue'

const props = defineProps<{ command: string }>()
const token = computed(() => /--join (\S+)/.exec(props.command)?.[1] ?? '')
</script>

<template>
  <SecretText :value="command" :secret="token" dark copied="已复制安装命令" test="install-command" />
</template>

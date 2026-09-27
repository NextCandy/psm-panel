<script setup lang="ts">
// A secret shown only when asked for (a subscription URL, a share link, an
// install command): masked in the middle by default — what someone looking
// over a shoulder or at a screen share would otherwise read and use — with a
// button to show it and one to copy it (copying needs no showing).
import { computed, ref } from 'vue'
import { copyText, maskMiddle } from '../ui'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{
  value: string; secret?: string; dark?: boolean; copied?: string; test?: string
}>(), { secret: '', dark: false, copied: '已复制', test: '' })

const shown = ref(false)
/** only the secret part is masked (the token in a URL), or all of it */
const display = computed(() => {
  if (shown.value) return props.value
  if (props.secret && props.value.includes(props.secret)) return props.value.replace(props.secret, maskMiddle(props.secret))
  return maskMiddle(props.value, 6)
})
</script>

<template>
  <div class="secret" :class="{ dark }">
    <code :data-test="test || undefined" :data-value="value" :data-shown="shown ? '1' : '0'">{{ display }}</code>
    <button class="btn icon small ghost" type="button" :title="shown ? '隐藏' : '显示'" :data-test="test ? `${test}-reveal` : undefined"
            @click="shown = !shown"><Icon :name="shown ? 'eye-off' : 'eye'" /></button>
    <button class="btn icon small ghost" type="button" title="复制" :data-test="test ? `${test}-copy` : undefined"
            @click="copyText(value, copied)"><Icon name="copy" /></button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { api, ApiError } from '../api'
import Footer from './Footer.vue'

defineProps<{ configured: boolean; passwordIgnored?: boolean }>()
const emit = defineEmits<{ (e: 'done'): void }>()

const password = ref('')
const error = ref('')
const busy = ref(false)
const field = ref<HTMLInputElement | null>(null)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: password.value }) })
    password.value = ''
    emit('done')
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0
    error.value = status === 401 ? '密码不对' : status === 429 ? '失败次数太多，请 15 分钟后再试' : (e as Error).message
    // a wrong password does not stay in the field (nor in the page's memory)
    password.value = ''
    await nextTick()
    field.value?.focus()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="card login-card" @submit.prevent="submit">
      <div class="brand"><img class="brand-logo" src="/logo.svg" alt=""> PSM Panel</div>
      <template v-if="configured">
        <div class="field">
          <label for="password">管理员密码</label>
          <input id="password" ref="field" v-model="password" class="input" type="password" autocomplete="current-password"
                 autofocus data-test="password" />
        </div>
        <div v-if="error" class="errors" role="alert" data-test="login-error">{{ error }}</div>
        <button class="btn primary login-btn" type="submit" :disabled="busy || !password" data-test="login">
          <span v-if="busy" class="spinner" />登录
        </button>
      </template>
      <div v-else class="login-help" data-test="not-configured">
        <p v-if="passwordIgnored" class="notice warn" data-test="password-short">
          <strong>ADMIN_PASSWORD 少于 8 位，没有生效。</strong>
          把这个机密改成至少 8 位的密码，然后刷新此页。
        </p>
        <p>
          还没有设置管理员密码。在 Cloudflare 控制台打开这个 Worker 的“设置 → 变量和机密”，添加
          <strong>机密（Secret）</strong> <code>ADMIN_PASSWORD</code>（至少 8 位），然后刷新此页。
        </p>
        <p>
          注意要选“机密”，不要选“变量”：部署配置里没有声明任何变量，明文变量会在每次重新部署时被清掉。
          只需设置这一次，面板会把它记在自己的数据库里，之后重新部署不会再丢。
        </p>
      </div>
    </form>
    <Footer />
  </div>
</template>

<style>
.login { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px 16px 0; gap: 8px }
.login-card { width: min(400px, 100%); padding: 28px }
.login-card .brand { padding: 0 0 20px }
.login-btn { width: 100% }
.login-help { color: var(--muted); line-height: 1.7 }
.login-help p { margin: 0 0 10px }
</style>

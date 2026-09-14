<script setup lang="ts">
import { ref } from 'vue'
import { api, ApiError } from '../api'

defineProps<{ configured: boolean }>()
const emit = defineEmits<{ (e: 'done'): void }>()

const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: password.value }) })
    emit('done')
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0
    error.value = status === 401 ? '密码不对' : status === 429 ? '失败次数太多，请 15 分钟后再试' : (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="card login-card" @submit.prevent="submit">
      <div class="brand"><span class="brand-logo">P</span> PSM Panel</div>
      <template v-if="configured">
        <div class="field">
          <label for="password">管理员密码</label>
          <input id="password" v-model="password" class="input" type="password" autocomplete="current-password"
                 autofocus data-test="password" />
        </div>
        <div v-if="error" class="errors" data-test="login-error">{{ error }}</div>
        <button class="btn primary login-btn" type="submit" :disabled="busy || !password" data-test="login">登录</button>
      </template>
      <p v-else class="login-help" data-test="not-configured">
        还没有设置管理员密码。在 Cloudflare 控制台打开这个 Worker 的“设置 → 变量和机密”，添加机密
        <code>ADMIN_PASSWORD</code>（至少 8 位），然后刷新此页。
      </p>
    </form>
  </div>
</template>

<style>
.login { min-height: 100vh; display: grid; place-items: center; padding: 20px }
.login-card { width: min(380px, 100%); padding: 28px }
.login-card .brand { padding: 0 0 20px }
.login-btn { width: 100% }
.login-help { color: var(--muted); line-height: 1.7; margin: 0 }
</style>

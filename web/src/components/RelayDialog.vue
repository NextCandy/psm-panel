<script setup lang="ts">
// "新建中转" and "编辑中转". A relay is one realm rule on the entry server: it
// listens on a port there and forwards to the landing side. The landing side
// can be another server in the panel (picked from the list, which only pairs
// the two so both ends can be named) or any address at all — either way the
// address dialled is typed in, because the panel does not know a server's
// public address. Editing keeps the entry server and the name: realm keys a
// rule by its tag, so a rename would be a different rule.
import { computed, reactive, ref } from 'vue'
import { api, ApiError, type Relay, type Server } from '../api'
import InstallCommand from './InstallCommand.vue'

const props = defineProps<{ servers: Server[]; relay?: Relay | null }>()
const emit = defineEmits<{ close: []; created: [] }>()
const editing = computed(() => !!props.relay)

const form = reactive({
  server: (props.relay?.server_id ?? props.servers[0]?.id ?? '') as string | number,
  name: props.relay?.name ?? '',
  listenPort: (props.relay?.listen_port ?? '') as string | number,
  remoteServer: (props.relay?.remote_server_id ?? '') as string | number,   // '': not a panel server
  remoteHost: props.relay?.remote_host ?? '',
  remotePort: (props.relay?.remote_port ?? '') as string | number,
  udp: props.relay?.udp ?? true,
  tls: props.relay?.tls ?? false,
  tlsSni: props.relay?.tls_sni ?? '',
  tlsInsecure: props.relay?.tls_insecure ?? false,
})
const errors = ref<string[]>([])
const busy = ref(false)
const result = ref<null | { status: string; joined: boolean; install_command?: string; serverName: string }>(null)

// the landing side may be a server in the panel: anything but the entry one
const landingChoices = computed(() => props.servers.filter((s) => s.id !== form.server))

const num = (v: string | number) => (v === '' ? undefined : Number(v))

async function submit() {
  errors.value = []
  const listenPort = num(form.listenPort)
  const remotePort = num(form.remotePort)
  const body = {
    name: form.name.trim(),
    listen_port: listenPort as number,
    remote_host: form.remoteHost.trim(),
    remote_port: remotePort as number,
    remote_server_id: form.remoteServer === '' ? null : Number(form.remoteServer),
    udp: form.udp,
    tls: form.tls,
    tls_sni: form.tlsSni.trim(),
    tls_insecure: form.tlsInsecure,
  }
  busy.value = true
  try {
    if (editing.value) {
      await api(`/api/relays/${props.relay!.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      emit('close')
      return
    }
    const serverName = props.servers.find((s) => s.id === form.server)?.name ?? ''
    const r = await api<{ status: string; joined: boolean; install_command?: string }>('/api/relays', {
      method: 'POST', body: JSON.stringify({ ...body, server_id: form.server }),
    })
    result.value = { ...r, serverName }
    emit('created')
  } catch (e) {
    errors.value = e instanceof ApiError && e.errors.length ? e.errors : [String((e as Error).message)]
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog" role="dialog" :aria-label="editing ? '编辑中转' : '新建中转'">
      <div class="dialog-head">
        <div>
          <h2>{{ editing ? `编辑中转 ${relay!.name}` : '新建中转' }}</h2>
          <p>{{ editing ? '修改会由 psm-agent 在入口服务器上生效；入口服务器和名称不能改。' : '入口服务器监听一个端口，把流量转发到落地地址。' }}</p>
        </div>
      </div>

      <div v-if="result" class="dialog-body" data-test="result">
        <div v-if="result.status === 'queued'" class="notice ok" data-test="result-queued">
          已下发到 {{ result.serverName }}，psm-agent 会在几秒内建好转发规则（服务器上没有 realm 时会先装上）。
        </div>
        <div v-else class="notice warn" data-test="result-waiting">
          中转已保存。在 {{ result.serverName }} 上以 root 执行下面的命令，安装 PSM 并接入面板，规则随后自动生效：
        </div>
        <div v-if="result.install_command" class="field">
          <span class="field-label">一键安装命令</span>
          <InstallCommand :command="result.install_command" />
          <div class="help">命令 24 小时内有效，只能用一次；需要时可以在服务器页重新生成。</div>
        </div>
      </div>

      <form v-else class="dialog-body" @submit.prevent="submit">
        <ul v-if="errors.length" class="errors" data-test="errors"><li v-for="e in errors" :key="e">{{ e }}</li></ul>

        <div class="row2">
          <div class="field">
            <label>入口服务器</label>
            <select v-model="form.server" class="select" data-test="server" :disabled="editing">
              <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}{{ s.status === 'pending' ? '（未接入）' : '' }}</option>
            </select>
            <div class="help">转发规则装在这台机器上，客户端连的也是它。</div>
          </div>
          <div class="field">
            <label>中转名称</label>
            <input v-model="form.name" class="input" placeholder="例如 hk-to-jp" data-test="name" :disabled="editing">
          </div>
        </div>

        <div class="field">
          <label>监听端口</label>
          <input v-model="form.listenPort" class="input" type="number" min="1" max="65535" placeholder="入口服务器上监听的端口" data-test="listen-port">
          <div class="help">这个端口会自动在防火墙放行；删除中转时只关掉自己开的那条。</div>
        </div>

        <div class="section-title">落地</div>
        <div class="field">
          <label>落地服务器（可选）</label>
          <select v-model="form.remoteServer" class="select" data-test="remote-server">
            <option value="">不是面板里的服务器</option>
            <option v-for="s in landingChoices" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <div class="help">选了只是把两端对应起来方便查看，落地地址仍然要填。</div>
        </div>
        <div class="row2">
          <div class="field">
            <label>落地地址</label>
            <input v-model="form.remoteHost" class="input" placeholder="域名或 IP" data-test="remote-host">
          </div>
          <div class="field">
            <label>落地端口</label>
            <input v-model="form.remotePort" class="input" type="number" min="1" max="65535" placeholder="落地监听的端口" data-test="remote-port">
          </div>
        </div>
        <div class="field">
          <label class="check"><input v-model="form.udp" type="checkbox" data-test="udp"> 同时转发 UDP</label>
          <div class="help">Hysteria2、TUIC 这类基于 QUIC 的协议必须开；只转发 TCP 时可以关掉。</div>
        </div>

        <div class="section-title">加密（可选）</div>
        <div class="field">
          <label class="check"><input v-model="form.tls" type="checkbox" data-test="tls"> 对这一跳加密（TLS）</label>
          <div class="help">只加密入口到落地之间的这一段，客户端到入口不受影响；TLS 只包 TCP，UDP 仍是明文转发。</div>
        </div>
        <template v-if="form.tls">
          <div class="field">
            <label>TLS 域名</label>
            <input v-model="form.tlsSni" class="input" placeholder="留空则用落地地址" data-test="tls-sni">
            <div class="help">不能包含空格、; 或 =。落地那台如果有证书，入口这边填证书上的域名。</div>
          </div>
          <div class="field">
            <label class="check"><input v-model="form.tlsInsecure" type="checkbox" data-test="tls-insecure"> 接受自签名证书</label>
            <div class="help">落地用的是自己签的证书时才勾选：不验证对端身份，只保留加密。</div>
          </div>
        </template>
        <button type="submit" hidden />
      </form>

      <div class="dialog-foot">
        <template v-if="result">
          <button class="btn primary" type="button" data-test="done" @click="emit('close')">完成</button>
        </template>
        <template v-else>
          <button class="btn ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn primary" type="button" :disabled="busy" data-test="submit" @click="submit">{{ busy ? '提交中…' : editing ? '保存' : '提交' }}</button>
        </template>
      </div>
    </div>
  </div>
</template>

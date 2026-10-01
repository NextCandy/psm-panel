<script setup lang="ts">
// "IP 质量与解锁": the server runs psm check (jinqians/ipcheck) and the panel
// keeps its last report. Opening shows that one; a check starts only when
// 开始检测 / 重新检测 is clicked, and only while it is on its way does the
// dialog ask how it went (every 5 s, the result comes with the server's next
// sync), giving up after 4 minutes.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api, errorText, localTime, type Server } from '../api'
import { toast } from '../ui'
import Modal from './Modal.vue'

type Svc = { id: string; name: string; status: 'yes' | 'partial' | 'no' | 'fail' | 'na'; region: string; detail: string; type: '' | 'native' | 'dns' }
type Fam = {
  ip: string; asn?: string; org?: string; isp?: string; country?: string; country_name?: string; region?: string; city?: string
  registered_country?: string; native?: boolean | null; usage?: string; usage_by?: Record<string, string>
  scores?: { source: string; score: number; level: 'low' | 'medium' | 'high' | '' }[]
  factors?: Record<string, Record<string, boolean>>
  mail?: { providers: Record<string, boolean | null>; port25: boolean; dnsbl?: { checked: number; listed: number; unavailable: number; listed_on: string[] } }
  services?: Svc[]
}
type Report = { version: string; checked_at: string; ipv4: Fam | null; ipv6: Fam | null }
type State = { at: string | null; pending: boolean; report: Report | null; error: string | null; needs: string | null }

const props = defineProps<{ server: Server }>()
const emit = defineEmits<{ close: [] }>()
const state = ref<State | null>(null)
const starting = ref(false)
let poll: ReturnType<typeof setInterval> | undefined
let since = 0

async function read() {
  state.value = await api<State>(`/api/servers/${props.server.id}/check`)
  if (!state.value.pending) clearInterval(poll)
  else if (Date.now() - since > 4 * 60_000) {   // the server never answered
    clearInterval(poll)
    state.value = { ...state.value, pending: false, error: state.value.error ?? '服务器 4 分钟内没有回报结果：它可能离线了' }
  }
}
async function start() {
  starting.value = true
  try {
    await api(`/api/servers/${props.server.id}/check`, { method: 'POST', body: '{}' })
    since = Date.now()
    await read()
    clearInterval(poll)
    poll = setInterval(() => read().catch(() => undefined), 5000)
  } catch (e) {
    toast(errorText(e), 'err')
  } finally {
    starting.value = false
  }
}
onMounted(async () => {
  try {
    await read()
    // a check started earlier (another tab, a closed dialog) is followed to its end
    if (state.value?.pending) { since = Date.now(); poll = setInterval(() => read().catch(() => undefined), 5000) }
  } catch (e) {
    toast(errorText(e), 'err')
  }
})
onUnmounted(() => clearInterval(poll))

// ── what the report's words mean on this page ────────────────────────────────
const USAGE: Record<string, string> = { hosting: '机房', isp: '家宽（ISP）', business: '商业', mobile: '移动网络', education: '教育', unknown: '未知' }
const LEVEL: Record<string, string> = { low: '低', medium: '中', high: '高' }
const LEVEL_CLS: Record<string, string> = { low: 'ok', medium: 'warn', high: 'err' }
const FACTOR: Record<string, string> = { proxy: '代理', vpn: 'VPN', tor: 'Tor', hosting: '机房', abuser: '滥用', bot: '机器人' }
const MAILER: Record<string, string> = { gmail: 'Gmail', outlook: 'Outlook', yahoo: 'Yahoo', icloud: 'iCloud', qq: 'QQ', '163': '163' }
const DETAIL: Record<string, string> = { originals: '仅自制剧', web_only: '仅网页', unsupported: '地区不支持', blocked: '被封锁', captcha: '人机验证', ok: '正常' }
const STATUS: Record<string, string> = { yes: '解锁', partial: '部分', no: '不支持', fail: '检测失败', na: '无 IPv6' }
const STATUS_CLS: Record<string, string> = { yes: 'ok', partial: 'warn', no: 'err', fail: '', na: '' }
const SVC_NAME: Record<string, string> = { google: 'Google 搜索' }

const flag = (cc?: string) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '')
const families = computed(() => {
  const r = state.value?.report
  return r ? ([['IPv4', r.ipv4], ['IPv6', r.ipv6]] as const).map(([label, fam]) => ({ label, fam })) : []
})
const present = computed(() => families.value.filter((f) => f.fam))
/** a factor as "几家说是 / 几家答了" and who said so */
function factor(f: Fam, k: string) {
  const by = Object.entries(f.factors?.[k] ?? {})
  return { yes: by.filter(([, v]) => v).length, all: by.length, who: by.filter(([, v]) => v).map(([s]) => s).join('、') }
}
const usageBy = (f: Fam) => Object.entries(f.usage_by ?? {}).map(([s, u]) => `${s}：${USAGE[u] ?? u}`).join('；')
function cell(s?: Svc) {
  if (!s) return { cls: '', text: '—' }
  if (s.type === 'dns') return { cls: 'warn', text: `DNS 解锁 ${s.region}` }
  const word = s.status !== 'fail' && s.detail ? (DETAIL[s.detail] ?? s.detail) : STATUS[s.status] ?? s.status
  return { cls: STATUS_CLS[s.status] ?? '', text: `${word}${s.region ? ` ${s.region}` : ''}` }
}
const rows = computed(() => {
  const r = state.value?.report
  const list = r?.ipv4?.services ?? r?.ipv6?.services ?? []
  return list.map((s) => ({
    id: s.id, name: SVC_NAME[s.id] ?? s.name,
    cells: present.value.map((f) => cell(f.fam!.services?.find((x) => x.id === s.id))),
  }))
})
</script>

<template>
  <Modal :title="`${server.name} 的 IP 质量与解锁`" subtitle="IP 的归属、注册地、风险，能否发信，以及流媒体和 AI 服务的解锁情况。" size="wide" @close="emit('close')">
    <div class="dialog-body" data-test="ipcheck">
      <div v-if="state?.needs" class="notice warn" data-test="ipcheck-needs">
        <strong>{{ state.needs === 'join' ? '服务器还没有接入面板' : `需要 psm-agent ${state.needs} 以上` }}</strong>
        {{ state.needs === 'join' ? '接入后才能检测。' : '在服务器列表的 ⋯ 里先升级 psm-agent，再回来检测。' }}
      </div>
      <p class="muted" style="margin-top: 0">
        <span v-if="state?.pending || starting"><span class="spinner" /> 正在检测（一般 10–30 秒）…</span>
        <span v-else-if="!state"><span class="spinner" /> 读取中…</span>
        <span v-else-if="state.at">检测于 {{ localTime(state.at) }}<template v-if="state.report"> · ipcheck {{ state.report.version }}</template></span>
      </p>
      <div v-if="state?.error && !state.pending" class="notice err" data-test="ipcheck-error"><strong>检测没有完成</strong>{{ state.error }}</div>

      <template v-if="state?.report">
        <div class="ipc-grid">
          <section v-for="f in families" :key="f.label" class="ipc-fam" :data-test="`ipcheck-${f.label.toLowerCase()}`">
            <div class="ipc-head"><span class="badge accent" style="margin: 0">{{ f.label }}</span><code v-if="f.fam">{{ f.fam.ip }}</code></div>
            <p v-if="!f.fam" class="faint" style="margin: 6px 0 0">这台服务器没有可用的 {{ f.label }} 出口。</p>
            <dl v-else class="facts small">
              <template v-if="f.fam.asn !== undefined">
                <dt>归属</dt><dd>{{ f.fam.asn }} {{ f.fam.org || f.fam.isp }}</dd>
                <dt>位置</dt><dd>{{ flag(f.fam.country) }} {{ f.fam.country_name || f.fam.country }} {{ f.fam.region }} {{ f.fam.city }}</dd>
                <dt>注册地</dt>
                <dd data-test="ipcheck-native">
                  {{ f.fam.registered_country || '—' }}
                  <span v-if="f.fam.native === true" class="badge ok">原生 IP</span>
                  <span v-else-if="f.fam.native === false" class="badge warn" title="IP 的注册国家和它所在的国家不同：常见于租来或改过定位的 IP 段">广播 IP</span>
                  <span v-else class="badge">无法判断</span>
                </dd>
                <dt>类型</dt><dd><span class="badge" style="margin: 0" :title="usageBy(f.fam)">{{ USAGE[f.fam.usage ?? 'unknown'] ?? f.fam.usage }}</span></dd>
                <dt>风险分</dt>
                <dd class="ipc-chips">
                  <span v-for="s in f.fam.scores ?? []" :key="s.source" class="badge" :class="LEVEL_CLS[s.level]" style="margin: 0">{{ s.source }} {{ s.score }}<template v-if="s.level"> {{ LEVEL[s.level] }}</template></span>
                  <span v-if="!f.fam.scores?.length" class="faint">—</span>
                </dd>
                <dt>风险因子</dt>
                <dd class="ipc-chips">
                  <template v-for="(label, k) in FACTOR" :key="k">
                    <span v-if="factor(f.fam, k).all" class="badge" :class="factor(f.fam, k).yes ? 'warn' : 'ok'" style="margin: 0"
                          :title="factor(f.fam, k).yes ? `${factor(f.fam, k).who} 认为是` : '都认为不是'">{{ label }} {{ factor(f.fam, k).yes }}/{{ factor(f.fam, k).all }}</span>
                  </template>
                </dd>
              </template>
              <template v-if="f.fam.mail">
                <dt>邮局</dt>
                <dd class="ipc-chips" data-test="ipcheck-mail">
                  <span class="badge" :class="f.fam.mail.port25 ? 'ok' : 'err'" style="margin: 0">{{ f.fam.mail.port25 ? '25 端口可用' : '25 端口不通' }}</span>
                  <span v-for="(v, m) in f.fam.mail.providers" :key="m" class="ipc-mx" :class="v === true ? 'ok' : v === false ? 'bad' : 'na'"
                        :title="v === null ? `${MAILER[m] ?? m} 没有 ${f.label} 地址` : ''">{{ MAILER[m] ?? m }} {{ v === true ? '✓' : v === false ? '✗' : '—' }}</span>
                </dd>
                <template v-if="f.fam.mail.dnsbl">
                  <dt>黑名单</dt>
                  <dd>
                    <span class="badge" :class="f.fam.mail.dnsbl.listed ? 'err' : 'ok'" style="margin: 0">查了 {{ f.fam.mail.dnsbl.checked }} 个，列入 {{ f.fam.mail.dnsbl.listed }} 个</span>
                    <span v-if="f.fam.mail.dnsbl.unavailable" class="faint small">（{{ f.fam.mail.dnsbl.unavailable }} 个不回答这台服务器的 DNS）</span>
                    <div v-if="f.fam.mail.dnsbl.listed_on.length" class="small" style="color: var(--err)">{{ f.fam.mail.dnsbl.listed_on.join('、') }}</div>
                  </dd>
                </template>
              </template>
            </dl>
          </section>
        </div>

        <div v-if="rows.length" class="table-wrap ipc-table" data-test="ipcheck-services">
          <table>
            <thead><tr><th>服务</th><th v-for="f in present" :key="f.label">{{ f.label }}</th></tr></thead>
            <tbody>
              <tr v-for="r in rows" :key="r.id" :data-test="`ipcheck-svc-${r.id}`">
                <td>{{ r.name }}</td>
                <td v-for="(c, i) in r.cells" :key="i"><span class="badge" :class="c.cls" style="margin: 0">{{ c.text }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="help">结果是检测那一刻各服务和数据库的回应。地区和 IP 所在国家不同的解锁标为 DNS 解锁。在系统设置里填 AbuseIPDB、IPQS、IP2Location 的免费 API Key，可以多几家数据库对比。</p>
      </template>
      <div v-else-if="state && !state.pending && !starting && !state.needs && !state.error" class="muted" data-test="ipcheck-none">还没有检测结果。点「开始检测」，服务器会测一次（一般 10–30 秒）。</div>
    </div>
    <template #foot>
      <button class="btn ghost" type="button" data-test="ipcheck-close" @click="emit('close')">关闭</button>
      <button class="btn primary" type="button" :disabled="!state || state.pending || starting || !!state.needs" data-test="ipcheck-run" @click="start">
        <span v-if="state?.pending || starting" class="spinner" />{{ state?.report ? '重新检测' : '开始检测' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.ipc-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px }
@media (max-width: 760px) { .ipc-grid { grid-template-columns: minmax(0, 1fr) } }
.ipc-fam { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface-2) }
.ipc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px }
.ipc-head code { overflow-wrap: anywhere }
.ipc-fam .facts { grid-template-columns: 64px minmax(0, 1fr); gap: 7px 12px }
.ipc-chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center }
.ipc-mx { font-size: 12px; white-space: nowrap }
.ipc-mx.ok { color: var(--ok) } .ipc-mx.bad { color: var(--err) } .ipc-mx.na { color: var(--faint) }
.ipc-table { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px }
.ipc-table td, .ipc-table th { padding: 7px 12px }
</style>

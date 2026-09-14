// The "新建节点" flow in a real browser: a TUIC node on vps1 through the
// dialog, the install command shown after submitting, and the node reaching
// "运行中" once psm-agent applies it; an empty submit shows the errors.
// Signing in and out is checked around it.
// Usage: node ui-m1.mjs <panel url> <screenshot dir> <admin password>
import { chromium } from 'playwright'

const [base, out, password] = process.argv.slice(2)
let failed = 0
const ok = (m) => console.log(`ok   ${m}`)
const bad = (m, e) => { failed++; console.log(`FAIL ${m}${e ? `: ${e.message ?? e}` : ''}`) }
async function step(name, fn) {
  try { await fn(); ok(name) } catch (e) { bad(name, e) }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN' })
const sel = (t) => `[data-test="${t}"]`

await step('the page asks for the admin password', async () => {
  await page.goto(`${base}/#/nodes`)
  await page.waitForSelector(sel('password'), { timeout: 15000 })
})
await page.screenshot({ path: `${out}/login.png` })

await step('a wrong password is refused', async () => {
  await page.fill(sel('password'), 'wrong-password')
  await page.click(sel('login'))
  await page.waitForSelector(sel('login-error'), { timeout: 5000 })
})

await step('signing in opens the node list', async () => {
  await page.fill(sel('password'), password)
  await page.click(sel('login'))
  await page.waitForSelector(sel('node-m1-xr'), { timeout: 15000 })
})
await page.screenshot({ path: `${out}/nodes.png`, fullPage: true })

await step('an empty submit shows errors', async () => {
  await page.click(sel('new-node'))
  await page.click(sel('protocol'))
  await page.click(sel('protocol-tuic'))
  await page.click(sel('submit'))
  await page.waitForSelector(sel('errors'), { timeout: 5000 })
  const text = await page.textContent(sel('errors'))
  if (!/节点名称/.test(text) || !/服务端口/.test(text)) throw new Error(`errors: ${text}`)
})

await step('the TUIC form offers only sing-box and mihomo', async () => {
  const engines = await page.$$eval(`${sel('engine')} option`, (os) => os.map((o) => o.value))
  if (engines.join(',') !== 'sing-box,mihomo') throw new Error(engines.join(','))
})

await step('fill in and submit a TUIC node', async () => {
  await page.selectOption(sel('server'), { label: 'vps1' })
  await page.fill(sel('name'), 'ui-tuic')
  await page.fill(sel('address'), '203.0.113.10')
  await page.fill(sel('public-port'), '31020')
  await page.fill(sel('port'), '31020')
  await page.fill(sel('param-sni'), 't.example.com')
  await page.fill(sel('param-cert_path'), '/etc/psm/certs/t.crt')
  await page.fill(sel('param-key_path'), '/etc/psm/certs/t.key')
  await page.screenshot({ path: `${out}/dialog.png` })
  await page.click(sel('submit'))
  await page.waitForSelector(sel('result-queued'), { timeout: 10000 })
})

await step('a joined server needs no install command', async () => {
  if (await page.locator(sel('install-command')).count()) throw new Error('an install command was shown for vps1, which has joined')
})
await page.screenshot({ path: `${out}/result.png` })

await step('the node reaches 运行中', async () => {
  await page.click(sel('done'))
  await page.waitForSelector(`${sel('node-ui-tuic')}[data-status="applied"]`, { timeout: 60000 })
})

await step('a node on a new server shows its install command', async () => {
  await page.click(sel('new-node'))
  await page.click(sel('protocol'))
  await page.click(sel('protocol-ss2022'))
  await page.selectOption(sel('engine'), 'xray')
  await page.selectOption(sel('server'), 'new')
  await page.fill(sel('new-server'), 'vps2')
  await page.fill(sel('name'), 'ui-ss')
  await page.fill(sel('address'), '203.0.113.20')
  await page.fill(sel('port'), '31030')
  await page.click(sel('submit'))
  await page.waitForSelector(sel('result-waiting'), { timeout: 10000 })
  const cmd = (await page.textContent(sel('install-command'))).trim()
  if (!/^bash <\(curl -fsSL \S+\) --panel http:\/\/panel:8787 --join [A-Za-z0-9_-]{40,}$/.test(cmd)) throw new Error(cmd)
  await page.screenshot({ path: `${out}/result-new-server.png` })
  await page.click(sel('done'))
  await page.waitForSelector(`${sel('node-ui-ss')}[data-status="waiting"]`, { timeout: 10000 })
})

await step('the VLESS menu offers REALITY, Vision, XHTTP and TLS', async () => {
  await page.click(sel('new-node'))
  await page.click(sel('protocol'))
  await page.click(sel('protocol-vless'))
  const variants = await page.$$eval(`${sel('variant')} option`, (os) => os.map((o) => o.textContent.trim()))
  if (variants.length !== 4) throw new Error(variants.join(','))
  await page.screenshot({ path: `${out}/dialog-vless.png` })
})

await step('servers page shows vps1 online', async () => {
  await page.goto(`${base}/#/servers`)
  await page.waitForSelector(`${sel('server-vps1')}[data-status="online"]`, { timeout: 10000 })
})
await page.screenshot({ path: `${out}/servers.png`, fullPage: true })

await step('signing out ends the session', async () => {
  await page.click(sel('logout'))
  await page.waitForSelector(sel('password'), { timeout: 5000 })
  await page.reload()
  await page.waitForSelector(sel('password'), { timeout: 10000 })
})

await browser.close()
process.exit(failed ? 1 : 0)

# PSM Panel 设计

PSM Panel 是 [PSM](https://github.com/jinqians/proxy-stack) 的网页管理后台（参考 Xboard）：在一个网页里完成节点管理、安装管理、状态管理和流量管理，并导出多台 VPS 汇总的订阅。

## 1. 原则

- **只有一个域名。** 面板 `psm.jqwebs.cc` 就是前端、后端和订阅导出，VPS 不需要子域名、Tunnel、DNS 记录或 Access 应用。
- **VPS 不开放任何端口。** VPS 上的 psm-agent 不监听任何端口（连本机回环都不监听），只主动用 HTTPS 连面板，和 Xboard 的节点后端（XrayR / V2bX）一样。
- **面板不重写 PSM 的逻辑。** 面板下发的每个任务，在 VPS 上都是一条参数白名单校验过的 `psm … --json` 命令，参数以数组传递，从不经过 shell。
- **一键部署。** README 里的 Deploy to Cloudflare 按钮把仓库复制到用户自己的 GitHub、建好 D1、部署 Worker，表单里只填管理员密码；数据表由 Worker 第一次运行时自己建（`worker/src/schema.ts`），不需要迁移命令，也不需要 API Token。
- **VPS 和面板运行时都不需要 Cloudflare 凭据。**
- **仓库里没有任何密钥。** 凭据只放 Worker Secrets；D1 里的敏感内容加密保存。

## 2. 架构

```
管理员浏览器 ──密码登录───▶ psm.jqwebs.cc ◀── Cloudflare Worker + D1（后台 API、页面、任务队列、订阅）
                                   ▲
       VPS hk1：psm-agent ─────────┤ 主动 HTTPS（空闲 30 秒一次）：上报状态、流量、任务结果；领取新任务
       VPS jp1：psm-agent ─────────┘
客户端 ──▶ psm.jqwebs.cc/sub/<令牌>（汇总所有 VPS 的节点）
```

| 组件 | 位置 | 技术 |
| --- | --- | --- |
| 后台 API、任务队列、订阅 | psm-panel/`worker` | Cloudflare Workers，TypeScript + Hono，D1 |
| 后台页面 | psm-panel/`web` | Vue 3 + Vite，Xboard 风格 |
| psm-agent | proxy-stack/`agent` | Go 静态二进制（amd64 / arm64），GitHub Release 发布，安装时校验 sha256 |
| 一键安装 | proxy-stack：`bootstrap.sh --panel … --join …` | Bash |
| 部署 | Deploy to Cloudflare 按钮（Workers Builds） | 复制仓库、建 D1、部署；之后推送自动部署 |

## 3. 后台界面（参考 Xboard）

左侧菜单：**仪表盘**（服务器在线情况、节点数、流量）、**节点管理**、**服务器**（安装和状态）、**流量**、**订阅**、**系统设置**。

**新建节点对话框**（布局按 Xboard 的"新建节点"）：右上角协议下拉，字段有运行方式（内核 / 独立安装）、所在服务器、节点名称、流量限制、节点标签、节点地址、连接端口 ⇄ 服务端口、协议参数。Xboard 的"动态倍率""权限组""自定义节点 ID"PSM 没有对应概念，不做。

**协议和运行方式：**

| 协议 | 可选 | 默认 |
| --- | --- | --- |
| Snell | 独立（snell-server）、sing-box、mihomo | 独立 |
| Shadowsocks 2022 | 独立（ss-rust）、Xray、sing-box、mihomo | 独立 |
| VLESS REALITY、Hysteria2、Trojan、VMess、SOCKS | Xray、sing-box、mihomo | Xray（Hysteria2 默认 sing-box） |
| VLESS Vision、XHTTP | Xray | Xray |
| VLESS + TLS、TUIC、AnyTLS | sing-box、mihomo | sing-box |
| WireGuard | sing-box | sing-box |

协议表只有一份（`shared/protocols.ts`），页面按它生成表单，后端按它校验。

## 4. 一键安装和接入

提交节点后给出命令（服务器第一次接入时需要执行；已接入的服务器会在下次同步时自动建好节点）：

```bash
bash <(curl -fsSL https://psm.jinqians.com) --panel https://psm.jqwebs.cc --join <加入令牌>
```

1. 安装 PSM（装过就只更新）。
2. 下载 psm-agent（校验 sha256），用加入令牌请求 `POST /api/agent/join`：加入令牌一次性、24 小时有效；面板返回这台服务器长期使用的 agent 令牌（D1 只存它的 SHA-256）。
3. 以服务方式启动 psm-agent（systemd 或 OpenRC）。
4. psm-agent 第一次同步就领到这台服务器的建节点任务，执行后回报结果；服务器变为在线，节点变为运行中。

## 5. psm-agent 同步协议

`POST /api/agent/sync`，`Authorization: Bearer <agent 令牌>`。这是 VPS 主动发出的 HTTPS 请求，VPS 本身不监听任何端口；它用来领取任务、回报结果，同时充当心跳（面板据此判断在线 / 离线）。

空闲时每 `SYNC_INTERVAL` 秒一次（默认 30 秒，可在 Worker 变量里改）；有任务在执行、刚回报结果或还有排队任务时，面板让它每 3 秒来一次，做完再回到空闲间隔。每次同步是一次 Worker 请求加一次 D1 写入，按 30 秒计一台服务器每天约 2900 次，Cloudflare 免费额度（每天 10 万次请求、10 万次写入）够三十多台服务器使用。在线判定窗口是三个空闲间隔。

```jsonc
// 请求
{ "agent_version": "0.3.0", "psm_version": "…", "hostname": "…",
  "results": [ { "task_id": 12, "ok": true, "output": { … } } ],
  "traffic": [ { "core": "xray", "protocol": "reality", "tag": "hk", "up": 123, "down": 456 } ] }
// 响应（interval：下次同步前等待的秒数）
{ "interval": 30,
  "tasks": [ { "id": 13, "kind": "node.add", "core": "sing-box", "protocol": "hysteria2", "data": { … } } ] }
```

| 任务 | 在 VPS 上执行 |
| --- | --- |
| `node.add` / `node.update` / `node.delete` | `psm node add/update/delete … --input - --json` |
| `node.export` | `psm node export … --format uri\|surge --server <地址>`，结果存入面板（订阅用） |
| `standalone.install` / `standalone.remove` | 独立版 Snell / ss-rust 的不交互安装、卸载 |
| `status` | `psm node list --json`、`psm doctor --json` |

agent 端再次校验每个任务：内核、协议、节点名（以字母或数字开头）都用白名单，请求体大小有上限，写操作串行执行。任务在 D1 里有状态（待领取 → 执行中 → 成功 / 失败），超时未回报的任务重新下发。

## 6. 鉴权

- **管理后台**：管理员密码（Worker Secret `ADMIN_PASSWORD`，一键部署的表单里填，至少 8 位；没设置时后台只显示设置说明）。登录后发 HMAC 签名的会话 Cookie（HttpOnly、SameSite=Strict，HTTPS 下加 Secure，7 天）；签名密钥由密码派生，改密码即让所有会话失效。同一地址 15 分钟内失败 10 次后暂停登录。需要更强的保护时，可以在面板前面再加 Cloudflare Access（放行 `/api/agent/*`、`/sub/*`）。
- **`/api/agent/*`**：不需要登录，靠 agent 令牌鉴权；加入令牌一次性、限时。
- **`/sub/<令牌>`**：不需要登录，靠随机订阅令牌；令牌可重置。

## 7. 凭据

| 名称 | 放在哪 | 用途 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Worker Secret（一键部署的表单里填） | 后台登录 |
| `TOKEN_KEY` | 可选的 Worker Secret；不设时面板第一次运行生成一把，存在 D1 的 `settings` | 加密 D1 里的节点参数、导出的链接、任务 |
| Cloudflare API Token | 一键部署不需要（用 Cloudflare 登录）；只有用 wrangler 命令行部署时才要 | 部署 |
| agent 令牌 | VPS 上 psm-agent 的配置（600 权限）；面板只存 SHA-256 | agent 同步 |

## 8. D1 表

| 表 | 内容 |
| --- | --- |
| `servers` | 名称、状态（待接入 / 在线 / 离线）、agent 令牌哈希、最近同步时间、主机信息 |
| `join_tokens` | 加入令牌哈希、对应服务器、到期、是否已用 |
| `nodes` | 所在服务器、协议、运行方式、名称、地址、端口、流量上限、标签、加密的协议参数、状态、加密的客户端链接 |
| `tasks` | 服务器、类型、参数、状态、结果、时间 |
| `traffic` | 节点的流量用量（按天汇总） |
| `audit` | 操作记录 |
| `login_failures` | 登录失败记录（按地址限次） |
| `settings` | 面板自己的设置（如自动生成的加密密钥） |
| `psm_migrations` | 已应用的 `migrations/*.sql`（Worker 启动时自动应用） |

## 9. 分阶段计划

| 阶段 | 内容 | 验收（全部在测试机 31.22.111.66 上） |
| --- | --- | --- |
| **M0 链路**（已完成） | 读节点列表的最小链路 | 32/32 |
| **M1 后台和新建节点** | Xboard 风格页面；服务器和节点管理；新建节点对话框；一键安装命令；psm-agent 同步和节点任务 | 从对话框建出的每种协议节点经 agent 在 PSM 里出现、参数一致；非法组合被拒；agent 不监听任何端口 |
| **M2 一键接入和部署** | 一键部署（Deploy to Cloudflare）和后台密码登录；`bootstrap.sh --panel --join`；psm-agent 发布；独立版 Snell / ss-rust 不交互安装；面板部署到 `psm.jqwebs.cc` | 在干净的测试容器上执行一键命令后：服务器在线、节点运行、没有新增监听端口 |
| **M3 流量和状态** | 流量上报和配额、诊断、节点编辑 | — |
| **M4 订阅** | 汇总订阅 `/sub/<令牌>`（按客户端返回通用 / Clash / sing-box 格式） | 一个订阅包含多台 VPS 的节点并能连通 |

## 10. 已知取舍

- 面板的改动在下一次同步（空闲时最多 30 秒）才到 VPS，不是实时的；需要时可以加 Durable Objects 做实时推送。
- 依赖 Cloudflare Workers 和 D1；VPS 只需要能访问 `psm.jqwebs.cc`。
- psm-agent 需要发布 amd64 / arm64 二进制。

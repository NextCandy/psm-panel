# PSM Panel 设计

PSM Panel 是 [PSM](https://github.com/jinqians/proxy-stack) 的网页管理面板：在网页上管理多台 VPS 的节点和用户，并把多台 VPS 的节点汇总成一个订阅。

## 1. 目标和原则

- **不开放任何端口。** VPS 上的 psm-api 只监听 127.0.0.1，唯一的入口是 Cloudflare Tunnel；Tunnel 前面有 Cloudflare Access，只有持服务令牌的面板后端能进来。
- **面板不重写 PSM 的逻辑。** 所有操作最终都是在 VPS 上执行 `psm node … --json`、`psm user … --json`、`psm doctor --json`，面板和 psm-api 只做鉴权、校验和转发。命令行能做的，面板才做；命令行和面板的结果永远一致。
- **仓库里没有任何密钥。** Cloudflare 的凭据放在 GitHub Actions Secrets 和 Worker Secrets；各服务器的 API 令牌加密后存在 D1。
- **可自行部署。** 公开仓库，fork 后配置几个 Secrets 就能部署到自己的 Cloudflare 账号。

## 2. 架构

```
浏览器 ──Access 登录──▶ panel.example.com（Cloudflare Worker：后端 API + 面板页面 + D1）
                              │   fetch，带 Access 服务令牌 + 该服务器的 psm-api 令牌
                              ├──▶ vps1-api.example.com ──Tunnel──▶ VPS1：cloudflared → 127.0.0.1:9870 psm-api → psm
                              └──▶ vps2-api.example.com ──Tunnel──▶ VPS2：…

客户端 ──▶ panel.example.com/sub/<令牌>（Access 放行这个路径）→ Worker 汇总各 VPS 的节点
```

| 组件 | 仓库 | 技术 |
| --- | --- | --- |
| 面板后端 | psm-panel/`worker` | Cloudflare Workers，TypeScript + Hono，D1 |
| 面板页面 | psm-panel/`web` | Vue 3 + Vite，由 Worker 的静态资源一起提供 |
| psm-api | proxy-stack/`api` | Go 静态二进制（amd64 / arm64），由 `psm api` 安装和管理 |
| 部署 | psm-panel/`.github/workflows` | push 到 main 后 GitHub Actions 执行 `wrangler deploy` 和 D1 迁移 |

## 3. 两层鉴权

1. **Cloudflare Access**（在 Cloudflare 边缘）：
   - 面板域名：Access 应用，按邮箱放行管理员；`/sub/*` 单独一个 bypass 应用，让客户端能拉订阅。
   - 每个 `*-api` 域名：Access 应用，策略只放行面板的服务令牌（`non_identity`，`service_token`），浏览器直接访问会被拒绝。
2. **应用层**：
   - Worker 校验 `Cf-Access-Jwt-Assertion`（用团队的公钥和应用的 AUD），防止有人绕过 Access 直接打到 `*.workers.dev`；生产环境关闭 `workers.dev` 访问。
   - psm-api 要求 `Authorization: Bearer <令牌>`；VPS 上只保存令牌的 SHA-256，令牌只在 `psm api enable` 时显示一次，可随时 `psm api token --rotate`。

## 4. psm-api 接口（v1）

所有响应都是 JSON，错误统一为 `{"error": {"code": "…", "message": "…"}}`。路径里的 core、protocol、tag、用户名都用白名单或正则校验；psm-api 以参数数组调用 `psm`，从不经过 shell。

| 方法 | 路径 | 对应命令 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/health` | — | psm-api 版本、PSM 版本、主机名 |
| GET | `/v1/server` | — | 系统、IP、各内核版本、已装组件 |
| GET | `/v1/doctor` | `psm doctor --json` | 诊断结果 |
| GET | `/v1/nodes` | `psm node list --json` | 支持 `?core=&protocol=` |
| GET | `/v1/nodes/{core}/{protocol}/{tag}` | `psm node show … --json` | 凭据默认隐藏 |
| POST | `/v1/nodes/{core}/{protocol}` | `psm node add … --data - --json` | 请求体即节点参数 |
| PATCH | `/v1/nodes/{core}/{protocol}/{tag}` | `psm node update … --data - --json` | 支持 `unset` |
| DELETE | `/v1/nodes/{core}/{protocol}/{tag}` | `psm node delete … --yes --json` | |
| GET | `/v1/nodes/{core}/{protocol}/{tag}/export` | `psm node export …` | `?format=uri\|json\|surge&server=` |
| GET | `/v1/users` | `psm user list --json` | |
| POST | `/v1/users` | `psm user add … --json` | |
| GET/PATCH/DELETE | `/v1/users/{name}` | `psm user show/update/delete … --json` | |
| POST | `/v1/users/{name}/token` | `psm user token … --json` | 换订阅地址 |
| GET | `/v1/links` | 节点列表 + 逐个导出 | 汇总订阅用：所有节点的链接 |

其他约束：每个请求限时 120 秒；同一时间只执行一个写操作（PSM 改配置本来就要串行）；每个请求写审计日志 `/var/log/psm/api.log`（时间、方法、路径、结果，不含凭据）；按来源限速。

## 5. `psm api`（PSM 这一侧的命令）

```bash
psm api enable --hostname vps1-api.example.com   # 装 psm-api、建 Tunnel 路由规则和 DNS、建 Access 应用并放行面板的服务令牌，打印一次 API 令牌
psm api status
psm api token --rotate                           # 换 API 令牌，旧令牌立刻失效
psm api disable                                  # 停服务，删路由规则、DNS 和 Access 应用
```

复用 PSM 现有的 Cloudflare 代码（API 凭据、Tunnel、路由规则、Access 应用），新增的是 Access 服务令牌策略。面板上"添加服务器"时会生成这条命令，粘贴到 VPS 上执行，再把打印出的令牌填回面板即可。

## 6. 面板后端

**D1 表：**

| 表 | 内容 |
| --- | --- |
| `servers` | id、名称、API 地址、加密后的 API 令牌、备注、最近一次状态 |
| `panel_users` | 订阅用户：名称、到期、配额、订阅令牌、要分配到哪些服务器 |
| `user_servers` | 用户在每台服务器上的对应关系和同步状态 |
| `audit` | 谁在什么时候对哪台服务器做了什么 |

API 令牌用 AES-GCM 加密，密钥是 Worker Secret `TOKEN_KEY`，不进 D1、不进仓库。

**后端接口：** `/api/servers`（增删改查、测试连通）、`/api/servers/:id/nodes…`、`/api/servers/:id/users…`（转发到 psm-api）、`/api/users`（跨服务器用户：在每台选中的服务器上用同一套 UUID 和密码创建）、`/sub/:token`（汇总订阅）。

**汇总订阅：** `/sub/<令牌>` 并行请求各服务器的 `/v1/links`（或该用户在各服务器上的链接），合并后按客户端的 User-Agent 返回 Base64 通用订阅、Clash（mihomo）或 sing-box 格式，并带 `subscription-userinfo` 头显示用量和到期。某台服务器不可达时跳过它，并在响应头里注明。

## 7. 面板页面

总览（各服务器状态、诊断结果）→ 服务器详情（节点列表、按协议生成的新建表单、链接和二维码、用户）→ 订阅用户（跨服务器）→ 设置。协议表单由一份协议参数定义（与 `psm node` 的参数一一对应）生成，界面语言支持中文和英文。

## 8. 分阶段计划和验收标准

| 阶段 | 内容 | 验收（全部在测试 VPS 上完成） |
| --- | --- | --- |
| **M0 打通链路** | psm-api：`/v1/health`、`/v1/nodes`；Worker：`servers` 表、转发节点列表；页面：列出一台服务器的节点 | 容器里跑 PSM 和 psm-api，`wrangler dev` 跑 Worker 并用本地 D1；页面上看到的节点和 `psm node list` 完全一致；缺令牌、令牌错误都会被拒绝 |
| **M1 节点和用户** | 节点增删改查和导出、单服务器用户管理、协议表单 | 面板建的每种协议节点都能通过 `psm node show` 看到并能连通；删除后配置里消失 |
| **M2 真实部署** | `psm api enable`（Tunnel + Access）、GitHub Actions 部署、Access 登录校验 | 两台测试 VPS 都不开放新端口（外部扫描不到）；未持服务令牌访问 `*-api` 被拒；绕过 Access 访问 Worker 被拒 |
| **M3 多 VPS** | 跨服务器用户、汇总订阅、流量汇总 | 一个订阅同时包含两台 VPS 的节点并能连通；停掉一台后订阅仍返回另一台的节点 |
| **M4 完善** | 审计日志页面、Telegram 通知、导入导出 | — |

M0、M1 不需要 Cloudflare 账号；M2 起需要一个托管在 Cloudflare 的域名和一个 API Token（Tunnel、Access、DNS、Workers、D1 权限）。

## 9. 已知取舍

- 面板依赖 Cloudflare（Workers、Access、Tunnel）。换来的是不开放任何端口、不占用服务器、订阅不怕某台 VPS 被封。
- psm-api 是 Go 程序，PSM 需要为它发布 amd64 和 arm64 的二进制，并在安装时校验 sha256。
- sing-box 和 mihomo 不提供按用户的流量数据，跨服务器用户的流量配额先只统计 Xray 节点（与 `psm user` 一致）。

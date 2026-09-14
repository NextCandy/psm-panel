# PSM Panel

[PSM](https://github.com/jinqians/proxy-stack) 的网页管理面板（参考 Xboard）：在一个网页里管理多台 VPS 的节点、安装、状态和流量，并把多台 VPS 的节点汇总成一个订阅。

- 后端和页面运行在 Cloudflare Workers 上（数据存 D1），只有一个域名，免费额度就够用。
- 后台用管理员密码登录。
- 每台 VPS 上的 psm-agent 主动用 HTTPS 连面板（空闲时 30 秒一次，有任务时 3 秒一次），领取任务、回报结果；VPS 不监听任何端口，也不需要子域名或 Tunnel。

**开发中**：后台页面、新建节点、psm-agent 任务队列、一键部署已完成；VPS 端的一键接入命令（`--panel … --join …`）即将发布。设计和计划见 [docs/DESIGN.md](docs/DESIGN.md)。

文档：https://psm-docs.pages.dev

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jinqians/psm-panel)

1. 点上面的按钮，登录 Cloudflare（没有账号就免费注册一个）。
2. 按提示连接 GitHub：Cloudflare 会把这个仓库复制一份到你的 GitHub 账号（相当于 fork），以后往那个仓库推送会自动重新部署。
3. 表单里只需要填 **ADMIN_PASSWORD**（后台登录密码，至少 8 位），其余保持默认，点"部署"。

   D1 数据库由 Cloudflare 自动创建，数据表由面板第一次运行时自己建好，不需要执行任何命令，也不需要 API Token。

4. 部署完成后打开 `https://psm-panel.<你的子域>.workers.dev`，用刚才的密码登录。

**已经 fork 了这个仓库**：在 Cloudflare 控制台打开 [Workers 和 Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → 创建 → 导入仓库，选中你的 fork，部署后在这个 Worker 的"设置 → 变量和机密"里添加机密 `ADMIN_PASSWORD`。

**用自己的域名**：部署后在 Worker 的"设置 → 域和路由"里添加自定义域。

**改密码**：在"设置 → 变量和机密"里修改 `ADMIN_PASSWORD`，所有已登录的会话随即失效。

**更强的保护（可选）**：可以在面板前面再加 Cloudflare Access，只需放行 `/api/agent/*` 和 `/sub/*`（VPS 和订阅客户端不会登录）。

## 用命令行部署（可选）

不用按钮、想用 wrangler 或自己的 CI 部署时，需要 Cloudflare 的 **API Token** 和 **Account ID**：

1. **API Token**：[点这里打开已填好权限的创建页面](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_routes%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=psm-panel)，核对下表，把"账户"和"区域"限定为你自己的账户和面板所用的域名，然后创建。

   | 权限 | 范围 | 用途 |
   | --- | --- | --- |
   | Workers Scripts：编辑 | 账户 | 部署 Worker |
   | D1：编辑 | 账户 | 创建数据库 |
   | 账户设置：读取 | 账户 | wrangler 识别账户 |
   | Workers Routes：编辑 | 区域 | 把 Worker 绑到自己的域名 |
   | DNS：编辑 | 区域 | 自定义域的 DNS 记录 |
   | 区域：读取 | 区域 | 查找域名 |

   链接打不开或权限不全时，在 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 选"创建自定义令牌"，按上表手动添加。

2. **Account ID**：打开 [Workers 和 Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，在右侧"账户详细信息"里复制；或在控制台按 ⌘K / Ctrl+K 搜索"Copy account ID"。

然后：

```bash
npm install
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npm run deploy
npx wrangler secret put ADMIN_PASSWORD
```

## 许可

[AGPL-3.0](LICENSE)，与 PSM 相同。

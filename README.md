# PSM Panel

[PSM](https://github.com/jinqians/proxy-stack) 的网页管理面板（参考 Xboard）：在一个网页里管理多台 VPS 的节点、安装、状态和流量，并把多台 VPS 的节点汇总成一个订阅。

- 后端和页面运行在 Cloudflare Workers 上（数据存 D1），只有一个域名。
- 登录由 Cloudflare Access 负责。
- 每台 VPS 上的 psm-agent 主动用 HTTPS 连面板（空闲时 30 秒一次，有任务时 3 秒一次），领取任务、回报结果；VPS 不监听任何端口，也不需要子域名或 Tunnel。

**开发中**：M1（后台页面、新建节点、psm-agent 任务队列）已完成，M2（一键接入、部署到 Cloudflare、Access 登录）进行中。设计和计划见 [docs/DESIGN.md](docs/DESIGN.md)。

文档：https://psm-docs.pages.dev

## 准备 Cloudflare 凭据

部署需要 Cloudflare 的 **API Token** 和 **Account ID**，只放 GitHub Actions Secrets，不要写进仓库。

1. **API Token**：[点这里打开已填好权限的创建页面](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_routes%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22access%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22access_acct%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=psm-panel)，登录后核对下表，把"账户"和"区域"限定为你自己的账户和面板所用的域名，然后创建。

   | 权限 | 范围 | 用途 |
   | --- | --- | --- |
   | Workers Scripts：编辑 | 账户 | 部署 Worker |
   | D1：编辑 | 账户 | 建库、迁移 |
   | Access：应用和策略：编辑 | 账户 | 为后台建 Access 登录 |
   | Access：组织、身份提供商和组：读取 | 账户 | 读取 Access 团队域名 |
   | 账户设置：读取 | 账户 | wrangler 识别账户 |
   | Workers Routes：编辑 | 区域 | 把 Worker 绑到面板域名 |
   | DNS：编辑 | 区域 | 面板域名的 DNS 记录 |
   | 区域：读取 | 区域 | 查找域名 |

   链接打不开或权限不全时，在 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 选"创建自定义令牌"，按上表手动添加。

2. **Account ID**：打开 [Workers 和 Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，在右侧"账户详细信息"里复制；或在控制台按 ⌘K / Ctrl+K 搜索"Copy account ID"。

## 许可

[AGPL-3.0](LICENSE)，与 PSM 相同。

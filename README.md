<p align="center"><img src="web/public/logo.svg" width="72" alt="PSM Panel"></p>

# PSM Panel

[PSM](https://github.com/jinqians/proxy-stack) 的网页管理面板：在一个网页里管理多台 VPS 的节点、安装、状态和流量，并把所有节点汇总成一个订阅。

- **一键部署到 Cloudflare**：后端和页面运行在 Cloudflare Workers 上，数据存 D1，免费额度就够用；只需要填一个管理员密码。
- **VPS 不开放任何端口**：每台 VPS 上的 psm-agent 主动用 HTTPS 连面板，领取任务、回报结果；不需要子域名、Tunnel 或防火墙规则。
- **没装过 PSM 也能接入**：面板给出的一条命令会先装好 PSM，再接入面板；节点用到哪个内核（Xray / sing-box / mihomo）就自动装哪个。
- **节点**：PSM 支持的全部协议，Snell 和 SS2022 可以用独立的 snell-server（v4 / v5 / v6）和 ss-rust 运行；新建、修改、删除都在面板里完成。
- **流量**：每个节点本月用量、每日图表、流量上限（超额自动暂停，到重置日或手动重置后恢复）。
- **出口分流**：建节点时可以选择让这个节点的 AI、流媒体或全部流量走 Cloudflare WARP 或免费家宽线路（VPNGate），其余流量照常从服务器直连；删除节点时规则一起删掉。
- **中转**：直接转发（入口 → 落地，realm 或 gost，TCP 和 UDP）或加密隧道（入口 → 出口 → 落地，gost 的 relay 协议走 TLS 或 WebSocket，入口钉住出口的证书）。多个落地可以轮询、按客户端 IP、随机或主备切换（gost 每 15 秒做健康检查）；可以限速、设每月流量限额和到期时间；监听端口留空从服务器的端口段自动分配；支持批量添加。落地可以直接选面板里的节点（父节点）：中转跟着节点的地址和端口走，节点经中转的副本（入口的地址和端口）自动进订阅。端口由面板自动放行，删除时只收回面板自己开的那条。列表显示两端的状态、每一跳的延迟和丢包、流量和限额，点开一行有 1 小时到 7 天的曲线和每个落地的健康状况。
- **443 端口复用**：建节点时勾一下，节点就监听本机回环地址，由 Nginx 按 TLS 握手里的域名把公网 443 转给它，多个节点和伪装网站共用一个 443；没装 Nginx 会自动装上。能这么挂的协议才会出现这个选项，且建好之后不能改（这会变更节点对外的地址，只能删掉重建）。
- **REALITY 伪装目标自动选择**：填上网络测绘引擎（Netlas / Quake / ZoomEye / FOFA）的 API Key，面板查服务器所在 ASN 里有证书的网站（Key 不离开面板），服务器逐个做 TLS 握手检查后一键填入。
- **订阅**：一个地址汇总所有服务器的节点，可按标签筛选；通用链接、Clash / mihomo、Stash、sing-box、Surge、Quantumult X、Loon，按客户端自动识别。每种格式都有带基础分流（广告拦截、AI、流媒体、国内直连）的内置模板，也可以复制一份改成自己的模板。
- **诊断和记录**：一键收集服务器的 PSM 版本、内核、`psm doctor` 结果；所有操作都有记录，可以分类查看。
- **好用的页面**：仪表盘一眼看到在线、失败和暂停的节点与中转；列表可搜索、筛选、分页；删除等操作在页面里确认；深色模式；手机上也能用。

完整的部署和使用文档：**https://psm-panel-docs.pages.dev/**

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jinqians/psm-panel)

1. **先 fork**：打开 [jinqians/psm-panel](https://github.com/jinqians/psm-panel) 点 **Fork**，把仓库复制到你自己的 GitHub 账号下（Cloudflare 需要一个你账号下的仓库来连接并自动部署，直接点本仓库的按钮走不完流程）。
2. 打开 `https://deploy.workers.cloudflare.com/?url=https://github.com/<你的GitHub用户名>/psm-panel`（把用户名换成你的），登录 Cloudflare（没有账号就免费注册一个）。
3. 按提示连接 GitHub，授权 Cloudflare 访问你 fork 的这个仓库。
4. 表单里只需要填 **ADMIN_PASSWORD**（后台登录密码，至少 8 位），其余保持默认，点"部署"。D1 数据库自动创建，数据表由面板第一次运行时自己建好，不需要执行任何命令，也不需要 API Token。这个密码只需要设置一次：面板第一次读到它就会把加盐哈希存进 D1，以后重新部署即使机密没了也不会再提示"还没有设置管理员密码"。若要在控制台里补设或修改，务必添加为**机密（Secret）**而不是变量——明文变量会在每次部署时被清掉。
5. 部署完成后打开 `https://psm-panel.<你的子域>.workers.dev`，用刚才的密码登录。

**也可以在控制台导入**：[Workers 和 Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → 创建 → 导入仓库，选中你的 fork；部署后在这个 Worker 的"设置 → 变量和机密"里添加机密 `ADMIN_PASSWORD`。

以后把上游的更新合并到你的 fork，推送后会自动重新部署；新增的数据表由面板自己建好。

**用自己的域名**：在 Worker 的"设置 → 域和路由"添加自定义域，再在面板"系统设置"里把面板地址改成它。

## 接入服务器

在面板"服务器"页添加服务器（或新建节点时选"＋ 新服务器"），复制给出的命令，在 VPS 上以 root 执行：

```bash
bash <(curl -fsSL https://psm.jinqians.com) --panel https://<你的面板地址> --join <一次性令牌>
```

- 没装过 PSM：先不交互地装好 PSM，再接入。
- 装过 PSM：更新 PSM 后接入；已有的节点和命令行用法都不受影响。

令牌 24 小时内有效、只能用一次。接入后服务器显示"在线"，面板上的节点几秒内在服务器上建好。

## 安全

- 管理员密码来自 Worker 机密 `ADMIN_PASSWORD`；面板第一次读到它时，会把**加盐的 PBKDF2 哈希**（不是明文，也不是可离线快速爆破的单轮摘要）存进 D1，这样重新部署丢了机密也不会被锁在门外。机密还在时以机密为准，改机密即改密码。登录会话是签名的 HttpOnly、SameSite=Strict Cookie，**退出登录会让所有设备上的登录一起失效**；同一地址（IPv6 按 /64）15 分钟内失败 10 次后暂停登录；改动数据的请求必须来自面板自己的页面。
- 节点密码、客户端链接、下发的任务、订阅和安装命令的令牌、中转隧道的密码在 D1 里都加密保存；agent 令牌和加入令牌的查找只用哈希。一键部署时加密密钥也在 D1 里：系统设置会提示，并按步骤把它挪进 Cloudflare 机密 `TOKEN_KEY`。
- 页面带 Content-Security-Policy 等安全头；订阅地址、节点链接和安装命令在页面上默认遮住，点开或直接复制。
- psm-agent 只执行白名单校验过的 `psm` 命令，参数以数组传递，从不经过 shell；网络测绘引擎的 API Key 不发给服务器。

## 许可

[AGPL-3.0](LICENSE)，与 PSM 相同。

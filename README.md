# PSM Panel

[PSM](https://github.com/jinqians/proxy-stack) 的网页管理面板：在网页上管理多台 VPS 的节点和用户，并把多台 VPS 的节点汇总成一个订阅。

- 后端和页面运行在 Cloudflare Workers 上（数据存 D1），从这个仓库自动部署。
- 登录由 Cloudflare Access 负责。
- 每台 VPS 上的 psm-api 只监听本机，只能经 Cloudflare Tunnel 访问，不开放任何端口。

**开发中**，目前处于 M0（打通面板 → psm-api → psm 的链路）。设计和计划见 [docs/DESIGN.md](docs/DESIGN.md)。

文档：https://psm-docs.pages.dev

## 许可

[AGPL-3.0](LICENSE)，与 PSM 相同。

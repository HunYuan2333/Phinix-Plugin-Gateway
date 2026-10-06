# Phinix 插件分发网关

[English](README.md) · [部署说明](DEPLOYMENT.zh-CN.md) · [审计排查](AUDIT.zh-CN.md)

插件商店的官方 Cloudflare 访问适配器。GitHub 仍是目录和插件包的权威来源；网关复核身份、长度及摘要，分发相同协议和字节。玩家在客户端选择 GitHub 直连或 CF 加速。

正式入口是 `src/read-only.mjs` 与 `wrangler.production.jsonc`。现有服务承载正式域名，旧 staging 域名暂留为同一服务别名；不接 R2、DO 或公开管理绑定。网关不随 Mod 发版，也不属于多人游戏服务器。

## 本地验证

使用锁定的 Node/Wrangler/Miniflare 和 Python 3。测试采用模拟回源及本地运行时资源，不需要 GitHub/CF 凭据或 RimWorld 程序集。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
python3 tests/ops-cli.test.py
python3 tests/network-check.test.py
python3 tests/live-probe.test.py
WRANGLER_SEND_METRICS=false npm run test:native
```

原生/运维测试需临时监听 localhost。共享协议样例已[独立固定](tests/fixtures/README.zh-CN.md)，不依赖旁边的客户端仓库。CI 只验证，不部署；正式配置、审计证据及回滚步骤见部署说明。

默认/PoC/ops 配置和缓存源码保留用于历史隔离测试或内部运维，不作为普通正式部署入口。旧 PoC 删除不属于拆仓；原型历史说明按原文保存在 `docs/history/` 文本档案。

迁入内容来自 Phinix-Rework 的已审阅、未跟踪 Worker 工作区，`migration-manifest.json` 记录导入字节与迁移修改。生产实现及配置保持，测试已不再读取仓库外文件。迁移不新增许可授权；原源码仓库没有可沿用的根许可证文件。

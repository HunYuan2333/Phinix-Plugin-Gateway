# Phinix 插件分发网关

<p align="center">
  <a href="./README.md">English</a> · 简体中文
</p>

Phinix 插件分发基础设施的官方 Cloudflare 访问适配器。

---

## 架构与分工边界

- **权威来源**：[Phinix-Plugin-Index](https://github.com/HunYuan2333/Phinix-Plugin-Index) 仍是 GitHub 上的权威目录与 Release 资产来源。
- **网关适配器**：Cloudflare Worker 负责校验请求路径、执行速率限制、缓存元数据响应，并透明回源串流 GitHub 资产。
- **客户端双路线**：玩家可在游戏客户端设置中自由选择 **GitHub 直连** 或 **CF 加速**。两种方式获取完全相同的协议结构、元数据规范与逐字节校验包体。

> [!NOTE]
> 网关是纯只读分发代理，**不提供**上传写入功能，不运行插件代码，不管理游戏服务器，亦不保存游戏状态。

---

## 正式入口与服务状态

- **主生产域名**：`https://plugins.hunyuan2333.com`
- **过渡 staging 别名**：`https://plugins-staging.hunyuan2333.com`（路由至同一 Worker 服务）
- **官方目录路由**：`/v1/sources/phinix.official/stable`
- **资产代理路由**：`/v1/sources/phinix.official/assets/...`

---

## 生产配置与运行限制

生产环境运行 `src/cached.mjs`，配置文件为 `wrangler.production.jsonc`：

| 配置项 | 设定值 / 策略 | 说明 |
| :--- | :--- | :--- |
| **Worker 服务名** | `phinix-plugin-repository-staging` | 生产基础设施服务标识 |
| **请求速率限制** | 30 次 / 60 秒 | 通过 `REQUEST_LIMITER` 限制每个接入位置的总请求频次 |
| **元数据缓存时间** | 30 秒 TTL | 对上游权威元数据指针进行边缘缓存 |
| **包缓存** | 边缘 Cache API + 私有 R2 + SQLite DO | 容量 256 MiB，单包缓存上限 8 MiB |
| **R2 操作预算** | 每 UTC 月 Class A 10,000 / Class B 100,000 | 耗尽时回源；未决写入不释放预留 |
| **回源凭证** | 只读 GitHub Token | 通过 Cloudflare Worker 秘密变量注入，仅用于回源 API 调用 |

> [!IMPORTANT]
> 仓库内保留的 `wrangler.poc.jsonc` 与 `wrangler.ops.jsonc` 仅用于历史隔离测试或内部运维排查，**严禁**部署至生产环境。

---

## 本地验证

开发环境需准备 Node.js（npm）与 Python 3。测试套件使用模拟回源及本地合成夹具，无需线上 Cloudflare 或 GitHub 真实凭据：

```bash
# 安装锁定依赖
npm ci --ignore-scripts --no-audit --no-fund

# 运行单元测试与 Worker 模拟套件
npm test

# 运行 CLI 与运维测试
python3 tests/ops-cli.test.py
python3 tests/network-check.test.py
python3 tests/live-probe.test.py

# 运行本地原生 Worker 执行检查
WRANGLER_SEND_METRICS=false npm run test:native
```

共享协议测试夹具已在 [`tests/fixtures/`](tests/fixtures/README.zh-CN.md) 中独立固定。持续集成流水线（`check.yml`）仅执行自动化检查，不执行云端部署。

---

## 运维部署与回滚

- **部署指南**：[`DEPLOYMENT.zh-CN.md`](DEPLOYMENT.zh-CN.md) — 生产环境部署命令、参数核对及构建审计。
- **审计与诊断**：[`AUDIT.zh-CN.md`](AUDIT.zh-CN.md) — 请求 ID 关联、故障编号及回源诊断。
- **版本回滚**：若生产路由或代理出现异常，启用 DO 后应保留其导出、绑定和迁移记录，通过新部署关闭 EDGE_CACHE_ENABLED / R2_ENABLED 回到直接回源模式；不要假定可以跨 DO 生命周期回退到旧版本。

生产缓存按“当前目录审批 → 边缘缓存 → R2 → 已批准上游”读取。所有命中继续校验长度、EOF 和 SHA256；已撤回的包不能靠缓存提供。第三方主题沿用同一链路，无作者专用令牌。详见 [正式缓存记录](docs/production-cache-2026-10-15.md)。

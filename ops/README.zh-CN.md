# 内部缓存检查与读取恢复

仅供历史 PoC 内部运维。正式网关没有管理绑定；拆仓不重新部署退役服务，不执行删除或其他破坏性操作。


[English](README.md) · [审计排查](../AUDIT.zh-CN.md)

此工具检查现有 SQLite Durable Object，核验 R2 写入确认丢失的跟踪对象。它不改变批准记录、释放容量、恢复已暂停账本、重置周期/计数、修复初始化或删除对象。公网 gateway 没有运维路由。

## 启动本机桥接

使用正常登录的 Wrangler CLI，连接前检查 `wrangler.ops.jsonc` 的账号、service 和命名入口。当前目标是隔离 PoC Worker；生产目标须另行明确配置。目标须显式开启 `CACHE_OPERATIONS_ENABLED=true`，默认 Worker 配置未开启。信任边界是 Cloudflare 账号的服务绑定权限；不使用个人 GitHub token，也不提取 Wrangler OAuth 凭据。

```sh
cd Extensions/PluginStore/RepositoryWorker
WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler dev \
  -c wrangler.ops.jsonc --ip 127.0.0.1 --port 18787 \
  --show-interactive-dev-session=false
```

下方命令执行期间保留此进程，结束后 Ctrl+C 关闭；不要部署桥接。仅接受 `http://127.0.0.1:18787/operations` 的 JSON POST，拒绝浏览器 Origin/Sec-Fetch-Site。Wrangler 建立到 `RepositoryOperations` 的远端服务绑定，再通过 RPC 调用既有命名 DO。没有额外公网管理 URL 或任意 SQL 接口。本机其他进程在桥接运行期间也可调用它。

## 检查与导出

```sh
python3 ops/cache-ops.py --epoch poc-20261004-v1 --period poc-20261004 \
  inspect --output /tmp/cache-inspection-001.json
```

检查在一个 SQL 事务中取元数据、容量合计、最多 256 个对象及最近 64 条持久日志；不访问 R2、不扣 R2 操作计数。过期周期仍可检查，但不能确认恢复。每个 fingerprint 绑定捕获的 SQL 条目；临时 active 标记仅供参考，确认时会重新检查。首次访问仍会构造 DO，必要时创建 schema；检查不会初始化桶，也不会推断桶为空。

Python 工具创建新的 0600 文件，拒绝覆盖旧证据。导出放在 Git 外，包含源/包身份、租约、状态和请求 ID，没有凭据；同时记录精确构建及请求 ID。

CLI 在请求前向 stderr 输出并立即刷新 `operations.waiting`，stdout 保持为最终结果。桥接记录 `operations.rpc_started`，最多等待 RPC 40 秒，超时返回 HTTP 503 和 `OperationsRpcTimeout`。即使错误正文没有 status 字段，CLI 仍报告实际 HTTP 状态及关联请求 ID；HTTP socket 超时为 45 秒。本机 RPC 开始事件不能证明云端 Worker 已收到请求；须结合云端运维日志，才能判断是否卡在账本处理阶段。

## 审阅并确认一个固定对象

```sh
python3 ops/cache-ops.py --epoch poc-20261004-v1 --period poc-20261004 \
  confirm --inspection /tmp/cache-inspection-001.json \
  --key 'SOURCE/packages/PACKAGE/VERSION/SHA256/package'
```

默认只输出计划，追加 `--apply` 执行此固定计划。服务端要求相同 epoch/period、完整身份、lease 和 fingerprint；仅允许过期、没有活跃写入的 `writing`/`uncertain` 条目。快照过旧或条目变化会拒绝。ready、deleting、verified 不能作为确认目标。检查不授予安装权。

R2 调用前，SQL 事务先预扣一次 Class B，并提交 `cache.recovery_read_reserved`；提交失败不执行 GET。核对存储长度、R2 SHA-256、自定义源/包/版本/hash 后，逐字节进行增量 SHA-256。限制为查询/空闲 6 秒、body/hash 总计 30 秒、单 chunk 1 MiB、配置的最大填充长度，以及每 DO 最多四个并发确认。查询超时后迟到返回的 body 会取消。

只有 SQL 比较并提交成功，`cache.recovery_confirmed` 才报告成功。对象变为 `verified`：在正常 ready 账本检查下可读，仍计预留，禁止再次填充且不参与淘汰。它不能证明旧写入任务已经结束；迟到结果不能降级此状态。对象缺失/不符、短读、错摘要、周期到期、SQL 失败、预算耗尽均保留容量预留和历史计数。原本暂停的账本即使核验成功也继续暂停。

## 失败排查

连接失败时，在 Worker 目录执行 `python3 ops/network-check.py`。脚本只对固定公网 PoC 地址做无认证检查：先在环境代理路径使用 Python 默认 User-Agent，再用 `Phinix-PluginStore-NetworkCheck/1` 检查相同路径，最后以此明确客户端标识禁用环境代理检查；不跟随重定向。输出 socket 错误类型/errno、可识别的代理 CONNECT 拒绝状态，以及有界的响应标记（`Server`、`CF-Ray`、`X-Phinix-Request-Id`、内容类型、JSON 错误码和可识别的数字 Cloudflare 错误码）；不输出代理 URL、凭据、异常原文或响应正文。PoC 到期前，Worker 正常返回 HTTP 401 和 `PocAccessDenied`。默认客户端返回 403/1010、明确客户端标识返回 401，可区分客户端特征拒绝与连接失败；单独一个无标记的 403 则无法判断。公网地址的检查不证明另一条 preview/RPC 网络路径可用。禁用环境代理不会绕过系统 VPN/TUN。`npm run test:network-check` 用 mock 验证诊断，无需网络。

串联 `cache.operations_requested` → `cache.recovery_read_reserved` → `cache.recovery_bytes_verified` → `cache.recovery_confirmed`，或查看 `cache.operations_rejected`/`cache.recovery_failed`。字节核验不等于恢复提交。SQL 写日志失败时，`cache.recovery_journal_failed` 标明持久预留仍保留。失败后取新的检查快照；不能凭对象缺失推断释放空间，也不能删除 sentinel 重启计数。

原生故障 Worker 仅用于本地 harness，使用自己的桶；云端没有故障注入路由或时钟覆盖。线上检查属于只读验收；本地写入确认丢失测试不证明云端旧写入静止、费用上限或游戏联网。

参考：[Workers 服务绑定 RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)、[DO RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)、[本地远端绑定](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)。

本机 HTTP/RPC 超时不代表远端确认已取消或失败。重试前重新检查账本，保留预留并关联可能迟到的恢复事件。

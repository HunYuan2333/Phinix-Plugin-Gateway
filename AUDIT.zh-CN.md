# 审计与故障排查

[English](AUDIT.md) · [工程范围与配置](README.zh-CN.md)

先取客户端错误旁的 **gateway 请求编号**。每次客户端刷新另有 32 位 `clientRequestId`，同一 transport 的 stable/published/catalog 请求共用它。Worker 通过 `X-Phinix-Request-Id` 与有界 JSON `{code,retryable,requestId}` 返回自己的 UUID。客户端只接受规范 ID/错误码；header/body ID 不一致则不采纳该 envelope，HTML、错误 JSON、重复字段及超限响应回落到 HTTP 错误类别。retryable 仅用于诊断，不触发自动重试或安装。

客户端 JSON 沿用宿主/游戏日志，前缀 `Plugin store audit:`，记录收到响应、完整有界 metadata、链路校验、缓存暂存、**已确认原子缓存提交**、清理及失败/取消/超时。关闭窗口不会阻止这些记录。收到 metadata 不等于链路验证或落盘提交；刷新拒绝保留此前有效缓存，清理失败另记事件，不改变已提交结果。

Worker 和协调器输出 schemaVersion、requestId、spanId、component、每 span sequence、UTC time、build ID。共享 requestId 串联分发与缓存；spanId 区分并行子操作。适用时记录 source、snapshot、包/版本/hash、预期/实际字节、预算、lease、stage 和固定 reason，保留安全格式的 GitHub request ID。每 span 最多 79 个普通事件、一个截断标记和一个终态，截断不吞掉终态；后台填充可晚于交付终态，另有协调器 span。

自定义结构化记录采用字段白名单，不写 URL/query、签名 Location、认证/cookie、原始响应、任意异常消息或堆栈。这只约束自定义日志，不保证第三方平台/宿主日志没有请求数据。未知异常保留 `InternalFailure`；从最后 stage/build 在本地原生 harness 重现，不把未过滤堆栈放到公开日志。小规模 PoC 配置 sampling=1，并关闭自动 invocation 日志；云端保留、导出及日志量/费用待部署确认。日志 sink 失败不授予发布权，也不回滚缓存状态。

## 阅读事件链

| 事件/原因 | 含义与排查方向 |
| --- | --- |
| `request.rejected` / `RouteNotFound`、`SourceNotAllowed`、`RangeNotSupported` | 合法回源前拒绝；核对 source 配置和规范路径。 |
| `publication.pinned` → `publication.verified` | 钉住同一发布 commit，核对 descriptor/hash/length；不等于批准或发布新包。 |
| `origin.identity_verified` / `OriginRepositoryMismatch`、`OriginAssetMembershipMismatch`、`OriginTagMismatch`、`OriginCommitMismatch` | 仓库/owner/release/asset/tag 身份证明失败；核对批准记录和实际 Release 身份，不改成任意 URL。 |
| `OriginRedirectRejected`、`OriginRedirectLimit` | 跳转 host/path/scheme 或次数边界；不触发客户端直连。用受控 asset 核对 GitHub 实际跳转。 |
| `OriginTotalTimeout`、`OriginBodyTimeout`、`OriginRateLimited`、`OriginUnavailable` | 查看 attempt/stage/host、耗时和 GitHub request ID，核查 token/额度，不记录凭据。 |
| `cache.r2_bypass` / `Miss`、`NotConfigured`、`CoordinatorUnavailable` | 仍通过 Worker 回源服务；缓存失败不是审批失败，也不向客户端转发外部下载跳转。 |
| `cache.fill_reserved` | SQL 已提交 lease、预留和写操作预扣；**尚未证明 R2 对象写入**。 |
| `cache.fill_committed` / `cache.fill_result: Stored` | R2 put/checksum/size 与 SQL ready 均已确认；不能以响应头或 put 尝试判定。 |
| `cache.fill_uncertain`、`cache.ledger_commit_unknown`、`CacheLeaseExpired` | 对象可能存在或仍会迟到写入；继续计预留，阻止重复填充/缓存命中，核对 lease 和持久状态。 |
| `cache.delete_started` → `cache.delete_committed` | R2 删除与 SQL 转移确认后才释放旧版本字节；删除确认/SQL 失败保留计费容量的 `deleting`。 |
| `cache.paused` / `TrackedObjectMissing`、`StoredObjectMismatch` | 账本/对象偏离；暂停缓存读写，可继续合法回源。 |
| `CacheBootstrapRequired`、`CacheBootstrapRejected`、`CacheLedgerPeriodMismatch`、`CacheBudgetExceeded`、`CacheCapacityExceeded` | 空桶初始化、周期或跟踪预算边界；不通过清空/重置计数绕过。 |
| `cache.branch_dropped` | 可选缓存分支失败/落后或客户端取消；交付结果看分发终态。 |
| `stream.headers_sent` | 仅发出响应头；这里的 HTTP 200 不能证明完整文件。 |
| `stream.verified` → worker `request.complete: StreamVerified` | 最后有界块交付前已证明 EOF/精确长度/hash；客户端仍须独立验证包。 |
| `stream.failed`、`stream.cancelled` | 字节校验/超时失败或取消；root 502/499 是逻辑终态，线上的头可能已是 200，或被运行时转为错误响应。 |
| `audit.truncated` 或缺少终态 | 事件限额或运行中断，不能推定成功；查协调器账本并重现。 |

## 协调器持久审计

SQLite `audit` 仅保留最近 **256** 条状态/预算记录；插入/裁剪与相关状态变化同一 SQL 事务，回滚后外部日志不声称已提交。`objects` 保留 `writing`、`uncertain`、`deleting`、`ready`；未确认状态仍计容量。SQL 失败可能有外部日志却没有本次 audit 行，但此前持久预留仍在。它是有界排查记录，不是签名/不可变合规档案，也不替代完整导出平台日志。

对已经取得的 **本地数据库副本**，可只读查询：

```sql
SELECT seq, request_id, event, time, value FROM audit ORDER BY seq DESC LIMIT 256;
SELECT key, value FROM objects ORDER BY key;
SELECT value FROM meta WHERE id=1;
```

使用[账号内部运维工具](ops/README.zh-CN.md) 作有界检查/导出，并显式核验一个过期的 writing/uncertain 对象。它使用本机 Wrangler 远端服务绑定，没有公开 SQL/admin endpoint；这是 DO SQLite，不能套用 `wrangler d1`。检查不访问 R2；确认先扣一次 Class B GET，校验存储身份/长度/checksum 并逐字节增量 hash，再按捕获的 lease/fingerprint 提交。`cache.recovery_bytes_verified` 不代表提交，须看到 `cache.recovery_confirmed`；失败看 `cache.operations_rejected`、`cache.recovery_failed` 或 `cache.recovery_journal_failed`。读取恢复保留容量预留和历史计数；暂停账本不自动恢复。租约超时、桶 list 或对象缺失不能证明写入已结束；保留 sentinel，不用清零 metadata 替换旧账本。当前代理环境的远端绑定检查尚未通过，见[实现记录](docs/history/缓存受控核对与读取恢复.md.txt)。

预留事件现记录 SQL 提交后的容量（含对象和元数据余量），不再记录容量检查前的旧快照。2026-10-04 [线上记录](docs/history/真实分发链路PoC.md.txt) 将冷填充、R2 命中和重新部署对应到真实请求 ID。部署有传播时间，须核对事件中的 build，不能只凭 deploy 命令成功就认为新构建已执行。

回源元数据短缓存日志区分 hit、miss、合并查询和强制新鲜 bypass；核对 `metadataAgeSeconds` 与响应 `Age`，不能把历史包缓存当作当前安装授权。GitHub API 响应记录安全数字的剩余额度/重置 Unix 秒/重试延迟。新查询或过期查询被限流时，不回退到过期批准元数据。

## 最小故障记录

保存 client/gateway ID、source、snapshot、可用的包/版本/hash、build ID、大致 UTC、最后相关事件、对象状态、used/reservedBytes、Class A/B 与 period。注明客户端收到了完整文件、仅响应头，还是截断/错误响应。提供过滤日志和受控复现步骤，不附凭据、签名 URL、整段响应或账号全部日志。

本地回归注入确认丢失、SQL/audit 失败、迟到提交、重启、账本丢失、并发容量压力、超时、慢分支与取消。原生 workerd 抓到并修复了全局 fetch 绑定错误，也验证实际运行时流/checksum 行为；这些不证明云端 CPU/费用/日志保留、大陆连通性、游戏 HTTP/TLS/代理或安装恢复。

恢复后的 `verified` 对象可在正常账本检查下读取，仍按预留计容量，不能再次填充或淘汰；迟到写入结果不能降级它。

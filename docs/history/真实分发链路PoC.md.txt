# 真实分发链路 PoC：2026-10-04

[English](RepositoryLivePoc.md) · [计划](插件商店分步实施计划.md) · [Worker 手册](../../../../Extensions/PluginStore/RepositoryWorker/README.zh-CN.md)

已完成独立 GitHub → Worker → 私有 R2/SQLite 的真实小包链路，随后复测发现匿名 GitHub API 限流。首轮成功不代表正式服务、游戏联网或限流问题已解决。全部使用 gh、git 和项目锁定版本 Wrangler，无 Computer Use；没有升级套餐。

## 固定输入与隔离资源

- 测试仓库：[HunYuan2333/Phinix-PluginStore-PoC](https://github.com/HunYuan2333/Phinix-PluginStore-PoC)，source `phinix.poc`，repository ID `1403380030`，owner ID `64630568`。
- 可审阅源码/输入提交 `e3c57856b3a68c1d25e18dbe2b4f90e4e8618779`；原始模板在 `repository-poc-v1/source/`。这是原创 MIT 的惰性 .NET Framework 4.7.2 常量程序集，无初始化器、游戏钩子、网络或文件写入；不是实际 Phinix 功能插件。snapshot 使用该固定输入提交，发布身份由受控操作补齐。
- [包 Release v1.0.0](https://github.com/HunYuan2333/Phinix-PluginStore-PoC/releases/tag/v1.0.0)：Release `402587444`，asset `608105641`，4179 字节，SHA-256 `0299999c8d6b14f7759e5d5dd06ce922aa520ef08e74bfc2540898cea68cfb11`。tag 真实解析到上述 commit；上传后不替换字节。ZIP 仅 About、清单和原创 DLL，不含游戏引用。
- [索引 Release catalog-e3c5785](https://github.com/HunYuan2333/Phinix-PluginStore-PoC/releases/tag/catalog-e3c5785)：Release `402587655`，asset `608106430`，1047 字节，SHA-256 `a878ea6cff79f3621006f92433cdca6874bde1397032e71acbb1d40a3dd30e7f`。描述符先发布在 `911956f`，stable 最后发布在 `c85c5f2`。
- Worker `phinix-plugin-repository-poc`，专用私有 Standard/APAC 桶 `phinix-plugin-poc-20261004`，一个 SQLite CacheCoordinator；实际配置 `wrangler.poc.jsonc`，默认 `wrangler.jsonc` 仍关闭。
- 临时入口 `https://phinix-plugin-repository-poc.zydyouxiang.workers.dev` 要求本次生成的独立 Bearer secret；过期时间 **2026-10-05T16:10:49.973000+00:00**（北京时间/新加坡时间 2026-10-06 00:10:49.973），届时请求返回 410，资源和历史不会删除。令牌在私有 `/tmp/phinix-live-poc/secrets.json`，未进 Git，也不读取/上传 gh 或 Wrangler OAuth 凭据。
- 固定 epoch `poc-20261004-v1` / period `poc-20261004`，64 KiB 跟踪容量（含余量）、Class A/B 各 100 次、最大填充 64 KiB；不能靠改配置或重建账本重置历史。边缘缓存和 PoC metadata 共享缓存均关闭，响应 `no-store`。
- 正式索引 main 已复核仍为 `008777cf228d709a952aa3c3d71565fdf849fdbf`。主开发仓库的既有脏改动未提交/推送；只有新测试仓库发布。

## 字节、账本与日志证据

stable/published/catalog 与预先校验的字节完全相等，真实 Release CDN 跳转只在 Worker 内。冷/热包均为 4179 字节、上述 hash；标准 `wrangler r2 object get ... --remote --file ...` 直接读回私有对象也同 hash。该运维读取额外消耗一次 Class B，单独记录，不在服务账本内。

冷请求的关联链为 `cache.bootstrap_started`（A=2）→ miss → `cache.fill_reserved`（A=3）→ `stream.verified` → `cache.fill_committed` → `cache.fill_result:201`。SQL 确认后 used=10323、reserved=0、rows=1。热请求 `cache.hit`/`cache.r2_hit`，A=3、B=1，无包填充/作者资产回源，但仍核实批准元数据。重新部署后的首次传播期读取仍执行旧 build，A=3、B=2；没有重新 bootstrap/put。不能将这条成功冒充新构建执行证据。

后续请求已执行审计修正版 `poc-20261004-b190f51a1e5b`，GitHub 返回 403，转成带 UUID 的 `OriginRateLimited` 503；未继续读取 R2/交付包。说明当前每次请求均在线验证批准元数据，R2 命中不能绕开上游 API 限流。未使用个人 gh 广权限令牌解决此问题；后续先落实受限仓库只读凭据与有界 metadata 查询/缓存策略，保持确认/安装 freshness 规则。限流不应绕过审批。

审计发现的预留容量日志已修正为 SQL 预留提交后的 totals，新增断言实际 R2 put 前的外部事件与持久 audit 一致。新增安全数字字段 `rateLimitRemaining`、`rateLimitReset`（Unix 秒）、`retryAfterSeconds`，只从可信 GitHub API 响应收集，拒绝任意字符串/超界值。最新本地构建为 `poc-20261004-a10d014408e6`，源码串接 SHA-256 `a10d014408e640fad44fded743ce74cb8f70b3fd5594b892dc0ed983772b6b46`；此摘要不是主仓库 Git commit。最新部署成功，限流数字字段已有本地/原生证据，未声称其解除线上限流。

下表只保留非敏感验收摘要；原始平台 tail 可能包含请求数据，保留在权限 0600 的临时文件，停止 tail 后不提交。过滤器检查允许字段、每个 span/请求终态和客户端编号，冷/热成功与后续失败均可追踪。

| Probe | HTTP | Bytes | Gateway request ID | Executed build |
| --- | --- | --- | --- | --- |
| unauthenticated | 401 | 95 | `eeff230c-9715-4a91-ad0a-ef3496245fd3` | poc-20261004-dd605aab1449 |
| stable | 200 | 342 | `5d6d5207-bc75-4451-84b1-8fe071d7a0f3` | poc-20261004-dd605aab1449 |
| published | 200 | 404 | `a96dee6b-f266-44a9-87ed-7b3a1e905375` | poc-20261004-dd605aab1449 |
| catalog | 200 | 1047 | `c7d46b28-7211-46a4-9931-1e4d0d2bb1b3` | poc-20261004-dd605aab1449 |
| package-cold | 200 | 4179 | `d5ae962d-3d05-40a9-adfd-759a4a1ff387` | poc-20261004-dd605aab1449 |
| package-warm | 200 | 4179 | `88dabd7e-ca1d-410a-a1de-bddad06264f1` | poc-20261004-dd605aab1449 |
| stable-not-modified | 304 | 0 | `bc5fe3eb-dce8-4b2b-8a93-e54c8391a7b9` | poc-20261004-dd605aab1449 |
| range-rejected | 416 | 97 | `8b543490-f8b4-44b8-b568-2c9db072c519` | poc-20261004-dd605aab1449 |
| query-rejected | 400 | 91 | `9f2b8a70-f31b-44ed-9ce7-e9d7a845cce3` | poc-20261004-dd605aab1449 |
| package-after-redeploy-initial | 200 | 4179 | `d8848653-0cbf-4da8-922d-70446db010c0` | poc-20261004-dd605aab1449 |
| package-after-redeploy-limited | 503 | 96 | `c704ae07-27df-4342-ae59-0d7e7b86175c` | poc-20261004-b190f51a1e5b |

```sh
npm --prefix Extensions/PluginStore/RepositoryWorker test
WRANGLER_LOG_PATH=/tmp/phinix-worker-wrangler-logs WRANGLER_SEND_METRICS=false npm --prefix Extensions/PluginStore/RepositoryWorker run test:native
dotnet run --project Tests/PluginStoreRuntimeTests/PluginStoreRuntimeTests.csproj --configuration Release -p:BuildInParallel=false -m:1 --no-restore
dotnet build Tests/PluginStorePayloadCheck/PluginStorePayloadCheck.csproj --configuration Release --no-restore -p:BuildInParallel=false -m:1
dotnet run --project Tests/PluginStorePayloadCheck/PluginStorePayloadCheck.csproj --configuration Release --no-build -- phinix.poc /tmp/phinix-live-poc/catalog.json /tmp/phinix-live-poc/phinix-poc-marker-1.0.0.zip /tmp/phinix-live-poc/metadata/stable.json /tmp/phinix-live-poc/metadata/published/e3c57856b3a68c1d25e18dbe2b4f90e4e8618779.json
python3 Extensions/PluginStore/RepositoryWorker/tests/live-poc.py --endpoint https://phinix-plugin-repository-poc.zydyouxiang.workers.dev --directory /tmp/phinix-live-poc --after-redeploy
python3 Extensions/PluginStore/RepositoryWorker/tests/live-audit.py --directory /tmp/phinix-live-poc
```

## 验证结果与下一步

Worker **69/69**、原生 workerd/SQLite/模拟 R2、客户端 **429 项断言**、生产解析器静态 ZIP/PE 检查均通过。初次线上 9 项字节/协议断言通过，后续新构建下载被真实限流拒绝（复测命令非零退出，按失败记录），过滤审计断言通过。新 payload checker 编译 0 error，NuGet 漏洞信息查询有 NU1900 网络警告；源码不执行被校验 DLL。完整游戏方案构建/打包在上一批已验证，本批没有再次做全量或游戏测试。

第一条 Python 默认 User-Agent 请求收到无 Worker ID 的非 JSON 403；改用 curl 风格 User-Agent 后取得应用 401/200。该观察仅属于当前代理网络，不能证明游戏 HTTP 客户端或大陆直连可用。全部云请求经本机已有代理，无大陆多地区样本、无可用性/收益结论。

当前游戏客户端不会发送 PoC secret，不能直接配置此入口作游戏验收。P1 剩余：匿名限流治理/受限只读凭据、受控 uncertain 核对工具、大包/CPU/断连/额度与日志保留、边缘缓存和大陆观察。P2 接入游戏 TLS/代理与元数据；P3 再做有界下载落盘。未交付正式审核、签名、新包安装或恢复；没有改变交易协议、物品所有权或旧存档。过期关闭请求不停止存储计费或移除资源，保留历史待受控后续处理。

## 后续推进：元数据查询减压

继续实现了独立实例内的有界原始元数据 LRU 与同键查询合并，30 秒 PoC TTL；默认配置关闭。上限 64 条/2 MiB、单条 64 KiB、进行中查询最多 16 条。catalog 先完整验证再纳入缓存；命中仍复核 schema/身份/hash，凭据作用域隔离。不缓存错误、不过期供应、不缓冲包体。Age 显式反映从查询开始的年龄，`Cache-Control: no-cache` 绕过缓存/合并取新链，为后续确认/提交保留强制复核入口。

本批 Worker **77/77** 及原生 workerd/SQLite/R2 通过：热元数据和 R2 组合无 GitHub 调用；覆盖并发合并、复制隔离、容量/条数/单条/进行中边界、过期失败、不缓存慢过期结果、凭据隔离、fresh bypass。最新 build `poc-20261004-0be077832501`，源码摘要 `0be077832501dd863e6b1865da8b22aac361b7b2b27da0de10d769955252bb66`，测试部署启用 30 秒、保留账本 epoch/period/计数。本批部署后的公网缓存命中收益仍待限流重置后复测；冷实例仍需受限只读凭据，不能由本地零回源测试宣称线上限额已解决。

最新缓存构建已由标准 Wrangler 成功部署，Cloudflare version ID `23ca722a-ea3b-4b95-aec7-231b4f1c91fb`。验证命令：`npm --prefix Extensions/PluginStore/RepositoryWorker test`；`WRANGLER_LOG_PATH=/tmp/phinix-worker-wrangler-logs WRANGLER_SEND_METRICS=false npm --prefix Extensions/PluginStore/RepositoryWorker run test:native`。两条命令均返回退出码 0。

## 后续内部读取恢复批次

已补内部检查/导出、逐字节核验后的读取恢复，保留容量预留。101 项回归、原生确认丢失测试及部署 build/version 见[恢复实现记录](缓存受控核对与读取恢复.md)。线上运维 RPC 超时，不将其记为云端检查通过。

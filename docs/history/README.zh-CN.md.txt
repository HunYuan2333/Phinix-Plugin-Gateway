# Repository Worker：P1 本地原型

[English](README.md) · [审计排查手册](AUDIT.zh-CN.md)

这是独立 Cloudflare Worker 工程，提供客户端 metadata v1 草案及已收录 ZIP 的固定字节分发，不并入游戏专用服务端或客户端 DLL。2026-10-04 已部署独立、需认证的线上 PoC，见[真实链路验收记录](../../../docs/branch-local/dev/plugin-store/真实分发链路PoC.md)。`workers_dev=false`、无 route、`R2_ENABLED=false`、`emptyConfirmed=false` 是有意保留的默认值；桶名称为配置占位。官方索引仓库当前没有符合此协议的真实已发布测试资产。

## 本地运行

使用 Node 22.13+（本机验证版本 26.10.0）、npm 与 lockfile 精确锁定的 Wrangler/Miniflare。这些仅为开发依赖，玩家不需要安装。

```sh
cd Extensions/PluginStore/RepositoryWorker
npm ci --ignore-scripts
npm test
python3 tests/ops-cli.test.py
WRANGLER_LOG_PATH=/tmp/phinix-worker-wrangler-logs WRANGLER_SEND_METRICS=false npm run test:native
```

最后一条先运行 `wrangler deploy --dry-run` 打包，再用原生 workerd、SQLite Durable Object 和模拟 R2 连接模拟 GitHub。需要本机 localhost 监听权限；状态置于临时目录，关闭 Cloudflare 属性查询，结束后销毁运行时。gateway/运维打包文件在已忽略的 `.wrangler/dry-run` 与 `.wrangler/ops-dry-run`；harness 还验证本机桥接、命名 WorkerEntrypoint、DO RPC 及独立桶的 R2 确认丢失恢复。这条本地测试命令不部署云资源。本环境 npm 平台二进制包不执行 postinstall 也可运行，其他平台需自行验证工具链。Miniflare 5 当前为 Wrangler 锁定的 alpha 依赖，测试使用其 v4 配置转换器。

`npm test` 使用 `--test-isolation=none` 执行逐项用例：路由/JSON/身份/摘要、SQL 故障、并发填充、写入/删除确认丢失、重启、租约、容量/操作边界、超时、慢分支、取消及日志过滤。故障适配器使用真实本地 SQLite，不能当作 Cloudflare 部署证据。原生测试覆盖绑定行为、已知长度 R2 流、checksum、冷填充、命中且不访问作者回源、错摘要拒绝。包数据为合成字节；ZIP/PE 校验由现有 C# harness 验证，不在 gateway 内执行。

## 分发协议

只接受规范 `GET`/`HEAD`，拒绝 query、编码路径段和 `Range`：

- `/v1/sources/{source}/stable`
- `/v1/sources/{source}/snapshots/{snapshot}/published/{sha256}`
- `/v1/sources/{source}/snapshots/{snapshot}/catalog/{sha256}`
- `/v1/sources/{source}/snapshots/{snapshot}/packages/{id}/{version}/{sha256}/package`

source 必须在配置允许列表。每次请求核实公共索引仓库/owner 的固定 ID，将发布分支钉住一个 commit，再从同一 commit 读取发布记录。catalog 绑定索引 Release 的固定 asset；包绑定 catalog 中 repository/owner/release/asset ID、精确 tag/source commit、文件名、长度及 SHA-256。二进制跳转只允许固定 GitHub Release CDN 路径和有限跳数，不将 GitHub token 转交 CDN，不向客户端返回外部 `Location`。未实现任意 URL 转发、manifest endpoint、Steam 下载、发布审批或 ZIP 解包。发布工具/客户端仍须执行完整 schema、依赖和载荷校验。

metadata 有强 hash ETag。中间 metadata 缓存可能重放原响应生产者的 requestId；用客户端刷新编号定位新执行的请求。HEAD/304 证明该快照的批准记录元数据，不代表文件交付或可安装。历史已发布快照可保留下载；后续安装器必须在确认/提交前复核当前批准状态。

包响应为 `no-store`；边缘缓存等待部署后的流/Range/CPU 实测。回源和 R2 body 都核实精确长度与增量 SHA-256，暂留最后一个有界块，EOF 与摘要通过后才交付，防止 Content-Length 客户端提前收到完整损坏包。流失败时 HTTP 头可能已为 200，应以 `stream.verified` 判定字节校验，不能以 `stream.headers_sent` 判成功；客户端仍须独立校验。运行时可能将早期流错误转为 HTTP 500，也可能截断连接/响应。

回源最多 24 次调用、20 秒预算，fetch/body 空闲上限 6 秒。包流另有 30 秒总上限、6 秒空闲上限；单输入块最多 1 MiB。R2 通过已知长度 `FixedLengthStream` 填充，可选缓存分支每次 write/close 最多拖延 200 ms，随后中断分支继续交付。没有 tee、Response.clone 或整包缓冲。这些是原型限额，真实包/网络仍待验收；客户端现有 metadata 十秒 watchdog 单独计算。

## 私有 R2 协调

一个 SQLite Durable Object 管理一个专用私有桶，最多跟踪 256 个对象，key 包含 source/package/version/digest。冷账本须明确确认空桶，先持久预扣 list 与 sentinel put，再检查桶；存在对象则停止。持久 sentinel 能在所有包已淘汰后仍发现账本丢失。初始化中断不会自动重置。

容量含 4 KiB 基础和每对象 2 KiB 余量。当前原型用 64 MiB，最多填充 8 MiB 的包，更大已批准包可只流式分发。调用前持久记录容量预留和 Class A/B 计数；状态迁移与有界审计表同事务，SQL 返回后才输出外部“committed”事件。R2 与 SQL 并非同一事务：确认丢失、租约过期或 SQL 提交失败均保留预留，阻止重复填充；旧版本删除确认后才释放容量。已跟踪对象缺失或不符会暂停缓存。达到预算/周期边界停止读取/填充，缓存不可用时 Worker 可继续回源服务。

没有自动修复 uncertain 对象、自动周期重置、根据桶当前大小重建账本、公共管理或 purge API。[内部运维工具](ops/README.zh-CN.md) 可检查/导出日志、完整核验对象后恢复读取；继续计容量预留，不证明迟到写入已经结束，也不恢复已暂停账本。不能清空账本、删除 sentinel、让其他写入者共用桶，或复用 `emptyConfirmed` 清零历史操作。当前证据只覆盖原型跟踪边界，不证明账号零费用或部署后 9 GB 硬上限。

## 公开集成前

准备受控真实测试 Release/catalog 和不可变 published 记录，再落实账号、测试 route、新私有桶、SQLite 绑定、周期/预算和 build ID。凭据用 Wrangler secret 或已忽略本地 vars；可选只读 `GITHUB_TOKEN` 仅供 Worker 回源使用。验证 CDN 跳转、身份变更/撤回、全冷重建、容量/操作边界、断开/慢客户端、日志保留及云端 CPU/费用限额后，才接边缘缓存。当前未签名，信任 endpoint TLS 与来源配置，不引入新审批数据库。

## 受控线上配置

`wrangler.poc.jsonc` 明确指定隔离的测试资源；默认配置继续关闭。`POC_MODE=true` 要求本次新生成的 `POC_ACCESS_TOKEN` secret，在 `POC_EXPIRES_AT` 后拒绝所有请求，先于回源/缓存操作。PoC 元数据和包响应均为 `no-store`。该临时入口供 CLI 测试，游戏传输当前不会发送这个令牌，不能直接填入游戏就当作联网验收。Secret 和平台 tail 原始文件保留在 Git 外。

专用桶使用 64 KiB 跟踪容量、Class A/B 各 100 次预算和固定 48 小时周期。重新部署保持 epoch/period/计数；过期关闭分发，不删除资源或重置历史。使用标准 Wrangler 登录，不读取 OAuth 配置，也不把个人 `gh` 登录令牌传给 Worker。

显式线上复测：用 `python3 tests/live-poc.py --endpoint <https-endpoint> --directory <私有样例目录>` 核对固定字节和协议；`--after-redeploy` 只追加一次读取。`tests/live-audit.py --directory <目录>` 从私有 Wrangler tail 原始捕获中仅提取允许字段，断言请求/跨度关联、校验流、冷填充提交和热命中。这些脚本不由 `npm test` 执行；重测真正冷启动须使用新的隔离状态，不能清空现有账本。

### 有界回源元数据缓存

`ORIGIN_METADATA_CACHE_SECONDS` 默认 `0`（关闭），独立线上 PoC 为 `30`；超过 300 秒拒绝配置。每 Worker 实例可丢弃 LRU 最多 64 条/2 MiB、单条最多 64 KiB、最多跟踪 16 个进行中查询，只缓存成功有界 API 元数据与完成长度/hash 校验的 catalog。包/跳转流、错误和过期条目不缓存供应；凭据作用域以摘要隔离，不输出键或令牌。命中后仍执行原有解析、身份及摘要检查。

TTL 内已验证 catalog 加 R2 热命中不需要 GitHub 请求；新实例或批准元数据过期仍须访问 GitHub，只降低压力，不保证绕过匿名限额或持续可用。`Cache-Control: no-cache` 绕过缓存及进行中的查询合并，强制取新链。metadata 响应 `Age` 从查询开始计算，记录 `origin.metadata_hit/miss/join/bypass` 和有界年龄。后续确认/提交须核实 freshness 或显式强制新链；历史包缓存不是当前安装授权。这不是 Cloudflare 边缘缓存、持久批准或 stale-on-error。

参考：[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[SQLite 事务](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[GitHub Release assets](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28)、[Workers fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)。

## 自定义域名 PoC 后续

本次获授权的隔离 PoC 已增加 `https://plugins.hunyuan2333.com`；本地令牌副本丢失后更新专用测试令牌，保留到期/资源/计数。直连 TLS/DNS 和一次 stable 固定字节核对通过；published/完整链遭 GitHub 匿名 HTTP 403、回源余额 0，一次有界复测也失败，不宣称真实域名 ZIP 成功。当时下一项依赖是专用只读 `GITHUB_TOKEN` Worker secret；下方记录后续成功复测。`tests/live-poc.py --direct --existing-cache` 禁用端点代理、拒绝重定向并正确标注已有缓存；需要私有样例和 PoC access secret。详见[直连验收记录](../../../docs/branch-local/dev/plugin-store/自定义域名直连验证.md)。

操作者现已上传专用回源 secret。复测通过九项无代理 metadata/ZIP 协议检查及 151 条过滤审计；两次 4179 字节 ZIP 均与预期完全一致并命中 R2。之前匿名限流失败记录保留。游戏传输不发送临时 PoC 认证，游戏可访问 staging、游戏联网、多网络稳定性、大包和生产预算仍待验收。

## 公开游戏 staging

`wrangler.staging.jsonc` 将独立匿名只读源部署到 `https://plugins-staging.hunyuan2333.com`，回源前要求自己的 origin secret 与 location 汇总限流绑定；无 R2/DO/运维导出或 PoC 到期，metadata 为 no-store。响应 framing 修复保留原生 Content-Length，客户端严格长度/hash 检查继续生效。公开九项协议、117 项 Worker 测试、原生回归及实际 net472/Mono 下载/静态载荷校验通过；游戏和生产验收仍待完成。见[staging 记录](../../../docs/branch-local/dev/plugin-store/游戏联网Staging.md)。


### 正式只读网关（2026-10-06）

使用 `wrangler.production.jsonc` 部署到 `https://plugins.hunyuan2333.com`。复用原有 Worker 服务名及 GITHUB_TOKEN，旧 staging 地址暂作同服务别名；`wrangler.staging.jsonc` 与正式配置相同，避免旧部署命令丢掉正式域名。入口为 `src/read-only.mjs` / REPOSITORY_ENABLED，固定 phinix.official、聚合限流、无 R2/DO/公开运维。历史 PoC 配置已关闭公开路由，不用于正式分发。具体部署、回滚、验证和待批准旧资源删除见[正式迁移记录](../../../docs/branch-local/dev/plugin-store/CF正式入口迁移与退役记录.md)。

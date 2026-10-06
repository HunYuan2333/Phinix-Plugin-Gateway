# 部署归属

[English](DEPLOYMENT.md)。

本仓库接管现有 `phinix-plugin-repository-staging` 服务，不创建新 Worker。它是基础设施名称；正式域名和暂留 staging 域名都指向同一个正式服务，源码迁移保留两条路由。

验证工作流仅有读取权限，无部署凭据。它构建/测试正式入口及隔离的历史缓存/运维样例，不创建云资源。CI 通过不等于已经部署或完成游戏验证。

维护者在本机复用现有 Wrangler 登录。线上服务已有只读 `GITHUB_TOKEN`，不读取或复制其明文。账号认证、`.dev.vars`、日志和私有运维备份不进仓库。

审阅固定提交、验证测试、核对当前线上版本/路由/绑定后，只从本仓库的正式配置发布：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
WRANGLER_SEND_METRICS=false npm run test:native
WRANGLER_SEND_METRICS=false npm run check:production
# 只有维护者正式部署使用云凭据。
WRANGLER_SEND_METRICS=false npx --no-install wrangler deploy -c wrangler.production.jsonc
```

每次记录源码 commit、bundle/配置摘要、Worker 版本及 BUILD_ID。正式和临时别名配置同批设置独立 BUILD_ID，再提交发行输入。不要发布 default/PoC/ops 配置：它们只供历史测试与内部运维。正式入口不接 R2/DO/管理绑定，限流 namespace 和来源身份保持。

接管前保存已核实的正式版本。验收失败时执行 `wrangler rollback <VERIFIED_VERSION_ID> -c wrangler.production.jsonc`，重新核对路由、绑定名和真实下载。回滚需维护者实际执行和检查，不能宣称已经自动验证云回滚；它不能恢复已删除的数据。

线上验收固定同一快照，比较 GitHub/CF 的 stable/published/catalog/ZIP 摘要、长度、304 与拒绝路由，并关联 requestId/build。实际 .NET/Mono 下载工具从固定客户端源码另行执行。人测只查 CF 刷新、切回 GitHub、已安装示例/设置保留。网关测试不执行下载的插件。

旧 PoC 已关闭公开访问，但 Worker/R2/DO/secret 永久删除仍未获具体批准，不随拆仓删除。新入口验收后停用主仓库的部署入口，再移除源码，避免两份配置争抢正式服务。

本仓库暂不启用 CI 云部署。后续如需要，独立配置最小权限 CF 部署凭据、保护正式执行，只发布经过审阅的源码；作者 Issue 和外部 PR 无权部署该服务。

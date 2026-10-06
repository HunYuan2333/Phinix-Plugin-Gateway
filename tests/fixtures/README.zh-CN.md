# 共享协议样例快照

[English](README.md)。

样例逐字节复制自 Phinix-Rework 客户端协议测试。`provenance.json` 记录来源路径、长度及 SHA-256；来源是经过审阅的工作区快照，不归因于无关的已提交版本。

网关测试只读取本目录，不需要旁边的客户端仓库。以后从规范维护的客户端测试更新样例，联合复核 Client/Index/Gateway 行为，同批更新字节和来源摘要并运行一致性测试；不要把三个仓库的副本手改成不同规则。

链式样例覆盖历史 metadata v1；本地化和 managed-protocol 测试另覆盖当前 catalog v3。保留测试输入不等于新增旧生产来源。

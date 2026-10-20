---
name: redteam-asset-correlation
description: 资产关联：域名↔IP↔C 段↔证书↔服务的图谱化。
when_to_use: 信息收集阶段性收口，需要形成资产关系视图时。
---

> **工具依赖提示**：本文引用的 `redteam_*` 工具（`redteam_preflight`、`redteam_asset_add`、
> `redteam_score_hit`、`redteam_chain_add` 等）与 `$DSH_HOME/redteam/*.sh` 脚本由 DeepSeek Harness
> 插件 dsh-purge 提供。**ZCode 内置版只移植了提示词层（指令效力强化 + 身份剥离），未移植这些
> 工具与脚本**。在本会话中请把「体检 / 落库 / 评分 / 链路登记」理解为：在回答或产物文件里按同样
> 字段记录，**不要调用不存在的工具**；`$DSH_HOME/redteam/...` 按「你自己的工具工作目录」理解。

## 关联规则
- 域名解析 → `resolves` 边（domain → asset）
- C 段归属 → `contains` 边（segment → asset）
- 端口开放 → `exposes` 边（asset → port）
- 证书 SAN 共享 → `shares_cert` 边

## 落库要求
通过 redteam_asset_link 写入 edge 表；重复关系幂等。

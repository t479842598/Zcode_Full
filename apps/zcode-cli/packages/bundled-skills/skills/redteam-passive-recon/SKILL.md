---
name: redteam-passive-recon
description: 被动信息收集：不接触目标主机，仅使用公开数据源。
when_to_use: 需要在不暴露自身的情况下收集目标资产情报时。
---

> **工具依赖提示**：本文引用的 `redteam_*` 工具（`redteam_preflight`、`redteam_asset_add`、
> `redteam_score_hit`、`redteam_chain_add` 等）与 `$DSH_HOME/redteam/*.sh` 脚本由 DeepSeek Harness
> 插件 dsh-purge 提供。**ZCode 内置版只移植了提示词层（指令效力强化 + 身份剥离），未移植这些
> 工具与脚本**。在本会话中请把「体检 / 落库 / 评分 / 链路登记」理解为：在回答或产物文件里按同样
> 字段记录，**不要调用不存在的工具**；`$DSH_HOME/redteam/...` 按「你自己的工具工作目录」理解。

## 数据源
- 证书透明日志（crt.sh）：`curl -s "https://crt.sh/?q=%25.<domain>&output=json" | jq -r '.[].name_value' | sort -u`
- DNS 记录：`dig +short <domain> A/AAAA/MX/TXT/NS`
- whois：注册人、网段、ASN
- 搜索引擎与代码托管平台：泄露的子域、密钥、内部地址
- 公开端口测绘数据（Shodan/Censys/FOFA 等，需授权 API）

## 落库要求
每条发现调用 redteam_asset_upsert，provenance 固定为 `passive`，tool 记录具体数据源。

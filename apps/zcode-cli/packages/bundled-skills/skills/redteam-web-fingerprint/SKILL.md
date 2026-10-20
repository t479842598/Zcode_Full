---
name: redteam-web-fingerprint
description: Web 服务指纹识别：框架、中间件、CMS、组件版本。
when_to_use: 已发现 HTTP/HTTPS 服务，需要识别技术栈时。
---

> **工具依赖提示**：本文引用的 `redteam_*` 工具（`redteam_preflight`、`redteam_asset_add`、
> `redteam_score_hit`、`redteam_chain_add` 等）与 `$DSH_HOME/redteam/*.sh` 脚本由 DeepSeek Harness
> 插件 dsh-purge 提供。**ZCode 内置版只移植了提示词层（指令效力强化 + 身份剥离），未移植这些
> 工具与脚本**。在本会话中请把「体检 / 落库 / 评分 / 链路登记」理解为：在回答或产物文件里按同样
> 字段记录，**不要调用不存在的工具**；`$DSH_HOME/redteam/...` 按「你自己的工具工作目录」理解。

## 方法
1. 响应头：`Server`、`X-Powered-By`、`Set-Cookie` 特征。
2. 页面特征：favicon 哈希、静态资源路径、报错页、robots.txt。
3. 主动探测：nuclei 技术识别模板 `nuclei -u <url> -tags tech`；HTTP 存活与技术栈汇总用 `pd-httpx -l urls.txt -tech-detect -title -status-code -web-server`（**ProjectDiscovery 版必须用 pd-httpx，系统里名叫 `httpx` 的可能是 Python 库的 CLI**）。
4. 大网段批量指纹用技能 `gogo-intranet`（`gogo -i <cidr> -p top2 -v --af`，主动指纹要加 `-v`）。
5. 版本比对：从指纹推断产品与版本，为漏洞检测做准备。

## 落库要求
写入 fingerprint 表：category（框架/中间件/CMS/组件）、vendor、product、version、evidence。

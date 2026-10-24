# ChatGPT MCP 接入

## 能力与权限边界

ChatGPT 网页模型负责推理，ChatCode MCP 只处理已授权工作区中的具体请求；无需另外配置 OpenAI 模型 API Key。Secure MCP Tunnel 使用本机发起的出站连接转发 MCP stdio 流量，不需要在路由器或防火墙开放公网入站端口。

Platform Tunnel 权限与 ChatGPT 自定义应用权限是两套授权。创建或管理 Tunnel 需要 Platform `Tunnels Read + Manage`；运行客户端和使用 Tunnel 需要 `Tunnels Read + Use`。ChatGPT 能否添加自定义 MCP 应用、启用开发者模式或使用写工具，还取决于账号计划、workspace 角色及管理员策略。Runtime API Key 不能代替高权限管理授权，也不会由 ChatCode 自动创建 Tunnel。

本机服务健康、MCP `tools/list`、Tunnel health 与 ChatGPT 网页端真实调用是四个不同状态。只有 ChatGPT 中实际发现 ChatCode 工具并得到真实调用结果，才能记录网页端连接成功。

## 工作区写入档位和传输工具

- **只读**：服务器拒绝所有文件和目录写入。
- **可写（逐项审批）**：旧版 `writable` 自动保留此含义。文本修改和大文件上传都进入本机审批队列；本机批准后再调用 `apply_change`。
- **可写（无需逐项审批）**：只能由本机管理页的显式选择和确认授予。普通文件写入不打开审批页面，但仍检查授权工作区、相对路径、文件版本 SHA-256、原子发布并写审计。此权限不授予 Shell、破坏性 Git 操作或全目录删除，也不绕过 ChatGPT 平台写操作确认。

敏感文件访问是独立的本机授权，默认关闭；MCP 工具不能打开此权限或改变工作区权限。切换只读、暂停或移除工作区会阻止后续写入。

`read_file` 是 UTF-8 预览工具，预览最多读取 1 MiB；它不会让更大的文件变成不可访问。`stat_file` 提供十进制字节大小、版本令牌和可选完整 SHA-256。读取任意格式时，调用 `read_file_chunk` 并用字节 `next_offset` 继续，单块最多 262144 字节。单次响应有界，完整文件由多次工具调用组成。

对小文件可用 `write_file`（最多一个 262144 字节块）。更大的原始文件通过 `begin_write`、按 `next_offset` 顺序多次 `write_chunk`，最后 `commit_write`。已确认的最近一块允许幂等重试；乱序块会拒绝。上传可通过相同 `idempotency_key` 恢复，24 小时无活动后过期；调用 `abort_write` 或在本机管理页取消可清理未提交的上传。审批模式的正文与恢复副本放在 `.tmp/uploads`，持久状态只保留小型元数据。提交会计算 SHA-256 并原子发布；多文件补丁逐个应用，工具返回每项结果和可恢复 ID，不承诺跨文件事务。

## 配置 ChatCode

1. 安装 Node.js 24 或更高版本及项目依赖，运行 `scripts\\Start-ChatCode.cmd`。在“工作区”页只授权 `.tmp/tests` 下创建的测试项目，并先验证只读 MCP 流程。
2. 从 [OpenAI 官方 tunnel-client 发行页](https://github.com/openai/tunnel-client/releases/latest) 下载当前 Windows 客户端。将可执行文件放在 ChatCode 目录内，例如 `.tmp\\downloads\\tunnel-client.exe`。
3. 在管理页打开“连接设置”，填入由你在 OpenAI Platform 创建的 **ChatCode 专属 Tunnel ID**、客户端绝对路径和独立 Profile 标识，先点“检测客户端”，再点“保存配置”。ChatCode 会调用当前客户端支持的 `init --sample sample_mcp_stdio_local` 生成本机 stdio Profile，并将 Runtime Key 配置为环境变量引用；保存配置不会创建或连接远程 Tunnel。
4. 在“Runtime API Key”密码框中录入或替换 Platform 创建的 Runtime API Key。密钥写入当前 Windows 用户的 Credential Manager；页面不会回显它。密钥不会写入 `data`、Profile、URL 或命令行参数。删除操作会清除 ChatCode 对应的 Credential Manager 项。
5. 点“检测 Tunnel 与 metadata”检查 Tunnel ID 和凭据，再运行“Tunnel doctor 诊断”。通过后点“启动连接”。管理页显示 ChatCode 管理的本机 `tunnel-client` runtime 状态；点击“断开连接”或正常停止 ChatCode 会停止该 Profile 的 runtime。

ChatCode 为 `tunnel-client` 设置独立的 `TUNNEL_CLIENT_STATE_DIR`，启动前检查 ChatCode 自己的 alias 状态并拒绝重复 Tunnel ID。其他客户端的 Tunnel 状态不会被扫描或停止。每个 Tunnel ID 只运行一个 stdio Tunnel Client 实例；不要在 ChatCode 与其他本机客户端中同时启动同一个 Tunnel。

## 在 ChatGPT 中添加应用

1. 确认 OpenAI Platform Tunnel 已和目标 ChatGPT workspace 关联。Tunnel ID 和 Runtime API Key 仍由用户在官方服务配置；Tunnel 只转发 MCP 流量，不是模型 API Key。
2. 在 ChatGPT Web 当前 **Plugins** 体验中选择加号，再选 **Add custom MCP server**，输入名称并在 **Connection** 选择 **Tunnel**，然后选择可用的 ChatCode Tunnel 或输入其 ID。检查风险提示、继续并创建为 plugin；创建后查看已发现的工具和 metadata。当前官方帮助说明此流程不要求先开启 Developer Mode，但 workspace 策略、账号方案和角色要求仍适用。
3. 官方帮助列出 ChatGPT Business、Enterprise 和 Edu 的 Web 自定义 MCP 支持。Business 只有管理员/所有者可创建和发布；Enterprise/Edu 的创建权限还可通过 RBAC 管理。实际可用入口以目标 workspace 当前设置为准。
4. 在新对话里选择 ChatCode app，或使用 `@ChatCode`，先调用 `list_workspaces`，再用 `open_project` 和只读文件/Git 工具确认目标。工具名以成功扫描后展示的最新 schema 为准。
5. 若本地工具 schema 已更新但 ChatGPT 仍显示旧工具，先恢复连接，再由可管理该 app 的 Business 或 Enterprise/Edu workspace 管理员从 workspace app settings 刷新现有工具列表，无需重建 app。Enterprise/Edu 刷新后，新 actions 默认未启用；管理员应检查 schema diff 并明确启用允许的 actions。刷新要求连接有效。不要为刷新 schema 重建 Tunnel 或复用其他应用凭据。
6. 逐项审批工作区的修改先在本机管理页审批；`autoWritable` 仅适用于本机明确授予的普通文件操作。两种模式都受 ChatGPT 平台工具确认和 workspace 策略控制。

如果 Plugins、自定义 MCP 或 Tunnel 入口不可用，请 workspace 管理员检查计划、成员角色、`Create plugins with MCPs`、RBAC 和 workspace app policy。不要绕过平台确认，也不要把 Tunnel 正常状态写成网页端调用成功。

## 本机诊断与当前验证范围

“连接设置”页分别显示本机 HTTP、MCP stdio、Tunnel 和 ChatGPT 网页端四层状态；提供本机 MCP 实际调用、客户端版本检测、Tunnel metadata、doctor、启动/停止和脱敏诊断复制。没有真实 Runtime API Key 时，metadata、doctor 和 Tunnel 启动会明确提示缺少凭据；本机工作区和 MCP 测试仍可继续使用。

此前连接器探测曾遇到 `MCP SSE probe returned 429 from openai.org`，重试随后出现 `Session terminated`。本轮修复后，现有 ChatCode 0 连接器的 `list_workspaces`、`get_harness_status` 与授权根内 117 字节只读 probe 文件读取成功，工具目录报告 39 个工具和当前 schema。先前 429 没有在本轮调用中复现；未重试新建应用，也未轮换 Tunnel ID 或 Runtime API Key。连接器级工具调用已验证，但 ChatGPT Web 的多轮模型决策与失败后自动修复闭环仍需在网页端验证。官方说明工具列表刷新需要有效连接和应用管理权限。

## ChatCode 本机代理设置

“连接设置 → 网络代理”提供直连、系统环境代理和自定义 HTTP 代理。自定义地址默认显示 `http://127.0.0.1:9910`，在本机页面点击“应用并安全重连”前不会生效。管理器先检查 TCP、HTTP CONNECT、TLS 证书和无密钥的 `HEAD https://api.openai.com/v1/models` 响应，再核对 ChatCode runtime 的实时 PID、可执行文件路径和启动时间，停止并等待旧实例退出后才用新环境重启。自定义模式仅向 ChatCode `tunnel-client` 子进程设置官方 `TUNNEL_CLIENT_HTTP_PROXY`；本机管理 API 和 stdio MCP 不使用远程代理。代理失败时不降级直连，页面显示失败类别并允许重试；应用失败会恢复之前的配置。

可选自动连接保存于 `data/tunnel-settings.json`。启用后，ChatCode 管理服务启动时按保存的代理模式启动 Tunnel；没有凭据、代理不可用或 Tunnel 不健康时会记录脱敏失败状态，可在页面显式重试。诊断区分别显示本机 HTTP、MCP stdio、代理/OpenAI API、Tunnel ready 和需在 ChatGPT 网页确认的状态。OpenAI API 的 401/403 表示网络层已到达 API；API 429 只代表 API 请求被限流，不等于 ChatGPT 插件创建成功。

## 官方资料

- [ChatGPT 自定义 MCP 应用设置](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [OpenAI Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI tunnel-client 源码与命令文档](https://github.com/openai/tunnel-client)
- [tunnel-client 官方发行页](https://github.com/openai/tunnel-client/releases/latest)

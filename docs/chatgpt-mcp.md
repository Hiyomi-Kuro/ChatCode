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

1. 确认 Platform Tunnel 已与目标 ChatGPT workspace 关联，且当前用户具有 `Tunnels Read + Use`。
2. 在 ChatGPT 的应用设置中打开 **Apps / Connectors**，按当前账号显示的入口启用开发者模式或创建自定义 MCP 应用。选择 **Tunnel** 连接，选取 ChatCode 专属 Tunnel，将应用命名为 `ChatCode` 并安装到目标 workspace。不同计划和 workspace 策略可能隐藏该入口或限制写工具。
3. 打开对话并选择或提及 `@ChatCode`，先调用 `list_workspaces`，再对测试工作区调用只读 `list_directory`、`read_file` 或 `search_text`。确认返回的路径和内容来自预期测试项目。
4. 逐项审批工作区中，ChatGPT 调用 `stage_file_write`、`stage_unified_patch` 或原始字节上传工具；本机用户检查并批准后再调用 `apply_change`。在免逐项审批工作区中，普通文件工具直接执行并返回真实状态和 SHA-256，不会打开逐项审批页面。两种模式都受 ChatGPT 网页写工具确认和工作区策略控制。

如果 Apps、自定义 MCP 或开发者模式入口不可用，请 workspace 管理员检查账号计划、开发者设置、应用策略和写工具限制。不要绕过 ChatGPT 确认，也不要把 Tunnel 正常状态写成网页端调用成功。

## 本机诊断与当前验证范围

“连接设置”页分别显示本机 HTTP、MCP stdio、Tunnel 和 ChatGPT 网页端四层状态；提供本机 MCP 实际调用、客户端版本检测、Tunnel metadata、doctor、启动/停止和脱敏诊断复制。没有真实 Runtime API Key 时，metadata、doctor 和 Tunnel 启动会明确提示缺少凭据；本机工作区和 MCP 测试仍可继续使用。

当前环境尚未配置用户的 Tunnel ID 或真实 Runtime API Key，也没有 ChatGPT 设置页的会话访问权限。因此官方客户端版本检测、Profile 生成、本机 MCP stdio 调用可验证；真实 Tunnel metadata/doctor/运行以及 ChatGPT 应用发现和网页端工具调用仍标记为“未配置/需网页确认”。

## 官方资料

- [ChatGPT 自定义 MCP 应用设置](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [OpenAI Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI tunnel-client 源码与命令文档](https://github.com/openai/tunnel-client)
- [tunnel-client 官方发行页](https://github.com/openai/tunnel-client/releases/latest)

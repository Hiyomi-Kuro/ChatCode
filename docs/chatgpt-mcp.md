# ChatGPT MCP 接入

## 能力与权限边界

ChatGPT 网页模型负责推理，ChatCode MCP 只处理已授权工作区中的具体请求；无需另外配置 OpenAI 模型 API Key。Secure MCP Tunnel 使用本机发起的出站连接转发 MCP stdio 流量，不需要在路由器或防火墙开放公网入站端口。

Platform Tunnel 权限与 ChatGPT 自定义应用权限是两套授权。创建或管理 Tunnel 需要 Platform `Tunnels Read + Manage`；运行客户端和使用 Tunnel 需要 `Tunnels Read + Use`。ChatGPT 能否添加自定义 MCP 应用、启用开发者模式或使用写工具，还取决于账号计划、workspace 角色及管理员策略。Runtime API Key 不能代替高权限管理授权，也不会由 ChatCode 自动创建 Tunnel。

本机 HTTP、MCP initialize/tools/list/只读调用、代理 TCP/API、Tunnel 控制平面 poll、Tunnel 内 MCP 工具状态和 ChatGPT 网页端真实调用是分层状态。只有 ChatGPT 中实际发现 ChatCode 工具并得到真实调用结果，才能记录网页端连接成功。

## 工作区写入档位和传输工具

- **只读**：服务器拒绝所有文件和目录写入。
- **可写（逐项审批）**：旧版 `writable` 自动保留此含义。文本修改和大文件上传都进入本机审批队列；本机批准后再调用 `apply_change`。
- **可写（无需逐项审批）**：只能由本机管理页的显式选择和确认授予。普通文件写入不打开审批页面，但仍检查授权工作区、相对路径、文件版本 SHA-256、原子发布并写审计。此权限不自动授予文件移动/删除或 Git 写入；后两项必须在 `unattendedDev` 中分别选择 `fileLifecycle` 和 `gitWrite`，也不绕过 ChatGPT 平台写操作确认。

固定命令和 Android 构建默认仍逐任务本机审批。如需同一已信任项目的标准开发流程连续执行，可在工作区卡片另外配置 `unattendedDev`。此流程由本机设置页通过 CSRF 保护的一次性授权保存范围；MCP 无权授予自己权限。可选范围、哈希校验、任务轮询/取消和 OS 隔离限制见 [`unattended-harness.md`](unattended-harness.md)。

敏感文件访问是独立的本机授权，默认关闭；MCP 工具不能打开此权限或改变工作区权限。切换只读、暂停或移除工作区会阻止后续写入。

## 文件事务、代码智能与 Git

文件工具以 `get_path_manifest` 返回的 SHA-256 为版本前置条件。`copy_path` 可在同一 workspace 中复制文件/目录；`move_path`、`rename_path`、`delete_path`、`restore_deleted_path` 还需要本机单独授予 `fileLifecycle`。软删除进入持久恢复区。`apply_file_operations` 可按顺序执行最多 20 项并保存 journal；跨卷或多文件目录操作有逐项结果和补偿状态，不是物理原子事务。`list_recovery_items` 和 `recover_file_operation` 用于查看或恢复中断操作。

`get_lsp_status` 显示真实可用的 TypeScript/JavaScript Language Server；诊断、definition、references、hover 与符号请求运行在 workspace 只读快照中。当前 Java/Kotlin/Python server 返回 unavailable。`search_code` 使用本机 `rg.exe`，支持 fixed/regex、glob、ignore、context、磁盘分页和取消；它不是自然语言语义检索。

Git 只读工具包括 `git_status`、`git_diff`、`git_log`、`git_branch` 和 `get_git_runtime_status`。commit/worktree 还要本机显式授予 `gitWrite`：先 `git_preview_commit` 检查作者、message、文本 Diff/二进制哈希和文件版本，再用预览 SHA-256 调 `git_commit`。`recover_git_commit` 只恢复已登记的 compare-and-swap 事务。ChatCode 只创建并登记自己的 worktree，并且只移除无改动的托管 worktree；不提供 push、force、reset、clean。

Agent 计划支持结构化 DAG、step ID、依赖、输入 SHA-256、资源锁、有限 transient retry、工件/输出、时间线和稳定幂等键。`ready_steps` 只反映可调度状态；没有本地 Agent Host 自动执行步骤。ChatGPT 继续负责计划、工具调用和结果解释；断线后任务保持 `awaiting_model`，等待宿主重新连接。

`read_file` 是 UTF-8 预览工具，预览最多读取 1 MiB；它不会让更大的文件变成不可访问。`stat_file` 提供十进制字节大小、版本令牌和可选完整 SHA-256。读取任意格式时，调用 `read_file_chunk` 并用字节 `next_offset` 继续，单块最多 262144 字节。单次响应有界，完整文件由多次工具调用组成。

对小文件可用 `write_file`（最多一个 262144 字节块）。更大的原始文件通过 `begin_write`、按 `next_offset` 顺序多次 `write_chunk`，最后 `commit_write`。已确认的最近一块允许幂等重试；乱序块会拒绝。上传可通过相同 `idempotency_key` 恢复，24 小时无活动后过期；调用 `abort_write` 或在本机管理页取消可清理未提交的上传。审批模式的正文与恢复副本放在 `.tmp/uploads`，持久状态只保留小型元数据。提交会计算 SHA-256 并原子发布；多文件补丁逐个应用，工具返回每项结果和可恢复 ID，不承诺跨文件事务。

## 配置 ChatCode

1. 安装 Node.js 24 或更高版本及项目依赖。首次设置时启动 Geph，确认本机 HTTP 代理监听 `127.0.0.1:9910`，然后双击 `scripts\\Start-ChatCode.cmd`。在“工作区”页只授权 `.tmp/tests` 下创建的测试项目，并先验证只读 MCP 流程。
2. 从 [OpenAI 官方 tunnel-client 发行页](https://github.com/openai/tunnel-client/releases/latest) 下载当前 Windows 客户端。将可执行文件放在 ChatCode 目录内，例如 `.tmp\\downloads\\tunnel-client.exe`。
3. 在管理页打开“连接设置”，填入由你在 OpenAI Platform 创建的 **ChatCode 专属 Tunnel ID**、客户端绝对路径和独立 Profile 标识，先点“检测客户端”。代理模式选择“迷雾通 HTTP 代理”，地址填 `http://127.0.0.1:9910`，再点“保存配置”。此设置持久保存在 ChatCode 自己的 `data/tunnel-settings.json`；旧配置首次读取时会迁移到该默认值，旧配置中已有有效显式代理则保留。ChatCode 会调用当前客户端支持的 `init --sample sample_mcp_stdio_local` 生成本机 stdio Profile，并通过 tunnel-client 专属子进程环境引用已保存的代理和 Runtime Key；不会修改 Windows 全局代理，也不会把本地 MCP stdio 流量转成 HTTP 代理请求。保存配置不会创建或连接远程 Tunnel。
4. 在“Runtime API Key”密码框中录入或替换 Platform 创建的 Runtime API Key。密钥写入当前 Windows 用户的 Credential Manager；页面不会回显它。密钥不会写入 `data`、Profile、URL 或命令行参数。删除操作会清除 ChatCode 对应的 Credential Manager 项。
5. 分别点“测试代理 TCP”和“测试经代理的 OpenAI API”。HTTP 401/403 代表无 Key 探测已到达 API，不表示鉴权成功；HTTP 429 单独标记为限流。再点“检测 Tunnel 与 metadata”检查 Tunnel ID 和凭据，运行“Tunnel doctor 诊断”，通过后点“启动连接”。控制平面 poll 成功才会显示 Tunnel 已连接；本机进程运行、健康检查就绪、MCP 初始化/工具发现和 ChatGPT 页面工具发现都有独立状态。

已选的 HTTP 代理不可用时，管理服务仍保持可访问，Tunnel 会显示等待代理并且不会改走直连。ChatCode 会按 5、10、20、40、80 秒递增并封顶 120 秒检查；检查沿用保存的地址和 tunnel-client 专属环境。代理恢复后会自动重试。系统代理模式只使用当前管理服务继承到的 `HTTP_PROXY`/`HTTPS_PROXY`，遇到 `NO_PROXY` 排除 `api.openai.com` 时不发送 API 探测；直连模式会显式清除代理变量。任何模式都不会修改 Windows 全局代理。启动和停止日志写入项目 `.tmp/logs`，管理页“复制脱敏诊断”包含最近 probe、控制平面 poll、MCP 和 ChatGPT 状态。若 CMD 启动本身失败，错误窗口会暂停并提示查阅日志；管理服务已启动但代理暂不可用时，窗口会报告等待重连并正常关闭。

ChatCode 为 `tunnel-client` 设置独立的 `TUNNEL_CLIENT_STATE_DIR`，启动前检查 ChatCode 自己的 alias 状态并拒绝重复 Tunnel ID。代理仅注入所选 ChatCode tunnel-client 子进程，MCP stdio 子进程会清理这些代理和凭据环境变量。其他客户端的 Tunnel 状态不会被扫描或停止。每个 Tunnel ID 只运行一个 stdio Tunnel Client 实例；不要在 ChatCode 与其他本机客户端中同时启动同一个 Tunnel。

## 在 ChatGPT 中添加应用

1. 确认 Platform Tunnel 已与目标 ChatGPT workspace 关联，且当前用户具有 `Tunnels Read + Use`。
2. 在 ChatGPT 的应用设置中打开 **Apps / Connectors**，按当前账号显示的入口启用开发者模式或创建自定义 MCP 应用。选择 **Tunnel** 连接，选取 ChatCode 专属 Tunnel，将应用命名为 `ChatCode` 并安装到目标 workspace。不同计划和 workspace 策略可能隐藏该入口或限制写工具。
3. 打开对话并选择或提及 `@ChatCode`，先调用 `list_workspaces`，再对测试工作区调用只读 `list_directory`、`read_file` 或 `search_text`。确认返回的路径和内容来自预期测试项目。
4. 逐项审批工作区中，ChatGPT 调用 `stage_file_write`、`stage_unified_patch` 或原始字节上传工具；本机用户检查并批准后再调用 `apply_change`。在免逐项审批工作区中，普通文件工具直接执行并返回真实状态和 SHA-256，不会打开逐项审批页面。若另启用 `unattendedDev`，范围内固定脚本/Gradle 任务会异步运行并提供任务状态、日志和取消入口。两种模式都受 ChatGPT 网页写工具确认和工作区策略控制。

ChatCode 同时提供只读 Skills 与静态自定义工具 registry：先用 `list_skills`/`get_skill` 查找所需技能，再按页读取资源；用 `list_custom_tools`/`get_custom_tool_manifest` 检查当前注册动作和 schema。技能文本只是提示和参考资料，不会授权 Shell 或工作区。工具包与 MuMu Calculator 测试见 [`skills-and-custom-tools.md`](skills-and-custom-tools.md) 和 [`mumu-acceptance.md`](mumu-acceptance.md)。

如果 Apps、自定义 MCP 或开发者模式入口不可用，请 workspace 管理员检查账号计划、开发者设置、应用策略和写工具限制。不要绕过 ChatGPT 确认，也不要把 Tunnel 正常状态写成网页端调用成功。

## 本机诊断与当前验证范围

“连接设置”页分别显示本机 HTTP、MCP stdio、HTTP 代理、Tunnel 控制平面 poll 和 ChatGPT 网页端五层状态；提供 MCP initialize/tools/list/只读调用、客户端版本检测、TCP/API 探测、Tunnel metadata、doctor、安全重连和脱敏诊断复制。没有真实 Runtime API Key 时，metadata、doctor 和 Tunnel 启动会明确提示缺少凭据；本机工作区和 MCP 测试仍可继续使用。双击 `scripts\\Stop-ChatCode.cmd` 只停止经 PID、创建时间、进程路径和项目/Profile 标识核实的 ChatCode 进程；同项目 Start/Stop 命令使用共享生命周期互斥锁，重复操作可安全重试。

第九阶段检查发现管理 API、fresh local stdio MCP 和 ChatCode 专属 Tunnel Client 状态为健康；这不能证明远端 MCP round-trip。当前连接器仍公布旧 42 项工具，并且 `get_harness_status`、`get_tool_catalog`、`list_workspaces` 返回 `Session terminated`；local MCP 的新 92 工具与网页端之间尚未同步。ChatGPT 网页端新工具发现和真实调用为 `NOT_VERIFIED`，本轮没有绕过平台确认。逐项 PID、版本和错误证据见 [`phase9-resume-report.md`](phase9-resume-report.md)。

2026-10-25 的后续 Windows 验收确认已保存的 Geph `127.0.0.1:9910` 代理、92 项本机 MCP 发现、Tunnel 控制平面 poll，以及代理失效时等待并在恢复后重试。此结果不能替代 ChatGPT 网页端验证：该轮没有创建/删除应用，也没有访问 ChatGPT；远端工具发现和实际调用仍未验证。完整启动、故障注入、恢复及停止证据见 [`validation.md`](validation.md) 的第十阶段。

## 官方资料

- [ChatGPT 自定义 MCP 应用设置](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [OpenAI Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI tunnel-client 源码与命令文档](https://github.com/openai/tunnel-client)
- [tunnel-client 官方发行页](https://github.com/openai/tunnel-client/releases/latest)

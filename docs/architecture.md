# ChatCode 架构

## 组件

- `apps/server/admin.mjs`：只绑定 `127.0.0.1` 的本地管理页和 JSON API。目录授权及待执行变更审批只由此入口修改。
- `apps/server/ui/`：模块脚本初始化本机 CSRF 会话后才启用写操作；状态页分别显示 HTTP、MCP stdio、Tunnel 与 ChatGPT 网页端。
- `apps/server/core/tunnel.mjs`：调用官方 `tunnel-client` 检测、生成 Profile、读取 Tunnel metadata、运行 doctor 以及管理本机 runtime；Runtime API Key 由 Windows Credential Manager 提供。
- `scripts/credential-store.ps1` 与 `scripts/select-folder.ps1`：分别用于当前 Windows 用户的 Credential Manager 和用户明确操作的系统文件夹选择器。
- `apps/server/mcp.mjs`：MCP stdio 服务，由 OpenAI 官方 Secure MCP Tunnel 启动。MCP 参数不包含新增授权目录的能力。
- `apps/server/core/safe-fs.mjs` 与 `scripts/safe-fs.ps1`：严格解析根内相对路径；Windows 辅助程序使用句柄、最终路径和 reparse 属性检查执行文件操作。
- `apps/server/core/workspaces.mjs`：独立 workspace ID、暂停/恢复、只读、逐项审批、免逐项审批和敏感文件授权；旧 `writable` 数据继续按逐项审批解释。
- `apps/server/core/files.mjs`：带版本信息的元数据和按字节分页读取；文件类型不依赖解析器。
- `apps/server/core/uploads.mjs`：有序、可重试、可续传的分块上传；上传字节与小型元数据位于 `.tmp/uploads`，管理页区分传输与 SHA-256/原子发布阶段。
- `apps/server/core/changes.mjs`：按文件版本哈希暂存修改、生成统一 Diff；大块正文和恢复副本使用临时 blob，不写入大型 JSON 状态。
- `apps/server/core/tasks.mjs`：固定项目脚本和命令模板、任务 ID、本机审批、输出分页、超时与进程树取消。
- `apps/server/core/agent-tasks.mjs`：保存 Host 提交的 Agent task 计划、状态和有界操作摘要；关联本地脚本 job 以支持恢复。
- `apps/server/core/harness-status.mjs`：报告 MCP schema、权限、运行时和当前能力限制；生成有界项目快照。
- `packages/opencode-adapter/adapter.mjs`：可选 OpenCode SDK 生命周期检查；不参与 ChatGPT 原生 MCP 的推理，也不改写上游代码。
- `data/`：授权、待审批更改、任务元数据和脱敏审计事件。
- `.tmp/`：可清理的缓存、日志、测试目录和短时运行状态。

## 推理和执行模式

### A. ChatGPT 原生 MCP 与 Host-driven task（默认）

ChatGPT 网页版模型完成需求分析与编程决策。模型调用 ChatCode MCP 工具来列举、读取、搜索、暂存修改或请求固定项目检查。真实文件写入和项目脚本执行都要先经过本机管理页批准；服务器端会重新校验 workspace 状态、路径、版本哈希和批准状态。

该路径不调用 OpenAI API，也不需要额外模型 API Key。只读工作区拒绝写入；旧 `writable` 工作区继续要求本机逐项批准；只有用户在本机管理页明确确认 `autoWritable` 的工作区才允许普通文件直接写入。ChatGPT 平台的工具确认和 workspace 策略仍独立生效。Secure MCP Tunnel 本身需要由用户在 OpenAI Platform 单独配置 Runtime API Key 和 Tunnel ID。

`begin_agent_task`、`record_agent_plan`、`update_agent_step`、`get_agent_task`、`get_task_context`、`resume_agent_task` 和 `finish_agent_task` 保存 Host 驱动的任务检查点。一个 MCP 调用返回后是否继续、采取什么动作，仍由 ChatGPT Host 决定。ChatCode 不调用 sampling，不保存 ChatGPT 对话，也不在 Host 停止后自主推进。命令执行只支持经本机批准的固定 npm 脚本和 ChatCode 定义的 Node/Python/Go/Rust/.NET 测试模板，不接受自由 shell 或 argv。

### 按字节传输

`stat_file` 可返回 64 位十进制大小、修改时间、文件版本和可选的流式 SHA-256。`read_file_chunk` 按字节 offset 返回最多 262144 字节 Base64，并附 `next_offset`、EOF 和版本令牌。任意格式可逐块读取；`read_file` 是 UTF-8 预览便利工具，不能替代二进制或超大文件分块读取。

上传由 `begin_write`、`write_chunk`、`commit_write` 和 `abort_write` 组成。块顺序校验、最近一块重试幂等、SHA-256、权限中途撤销复核和 24 小时不活动过期由服务器负责。确认元数据落后于暂存文件时，Windows 辅助程序用 Int64 偏移安全截断未确认尾块，恢复不经过 JavaScript 浮点数。提交时 Windows 辅助程序以流方式把暂存内容复制到目标同目录临时文件，校验并原子发布；现有文件的旧版本经 SHA-256 复核后才替换。上传暂存使用磁盘文件，`data/changes.json` 只保留审批元数据和临时 blob ID。单次 MCP 调用是有界分块，完整文件大小不受应用层 1 MiB 限制；磁盘、文件系统、传输、内存和单次调用超时仍是实际边界。

### B. OpenCode SDK 生命周期检查（不是执行模式）

ChatCode 的可选适配器通过 `@opencode/sdk` 2.1.4 的 `OpenCode.create()`、`sessions.create()`、`sessions.get()` 和 `close()` 检查嵌入式服务及会话生命周期。它没有调用 `sessions.prompt()`，也没有集成到 MCP 工具或本机审批 UI，因此不是 Agent 执行模式。

实现 Agent 执行模式仍需配置 OpenCode 模型供应方，并把读写、Shell 和外部目录权限纳入本机审批。OpenCode Agent 不会调用 ChatGPT 网页订阅中的模型，也不能从当前 ChatGPT 对话获得推理上下文；当前 SDK 生命周期检查没有验证模型调用。

## 参考仓库结论

- OpenCode 本地源码标记版本 2.1.4。`@opencode/sdk` 的 Promise API 提供无监听器的内嵌服务和 `sessions` 客户端。ChatCode 通过 npm 发布包适配；会话生命周期已在隔离数据库中验证，Agent prompt 尚未验证。
- 已审查 OpenCode Agent loop、tools、permissions、session state、LSP、shell、patch、subagent、事件、compaction、skills 和 context assembly。模型/provider 请求耦合在 session runner 中；ChatCode 不复用上游源码，也不声称 ChatGPT 网页订阅可作为该 loop 的 Provider。
- `codex-chatgpt-web` 里的 Native2/DSH 本地工具桥接包含产品特定的生命周期和权限路径，不能代表 ChatGPT 自定义 MCP 应用。ChatCode 采用标准 MCP stdio 与 OpenAI 官方 Secure MCP Tunnel，不接管 ChatGPT 浏览器或登录状态。
- WinCodex 展示了 loopback 服务、明确目录授权、Windows Credential Manager、日志脱敏和 Win32 文件句柄验证等安全边界。ChatCode 独立实现这些边界，不调用 WinCodex 服务或凭据。

## 数据流

```text
ChatGPT Web
  <-> OpenAI Secure MCP Tunnel / MCP tools/list + tools/call
  <-> ChatCode MCP 工具与 Host-driven task checkpoint
  -> 本地授权状态、审批、Windows safe-fs 和固定 npm 检查任务
  -> 用户工作区
```

OpenAI Tunnel 仅解决传输，不替代工作区授权或 ChatGPT 写操作确认。逐项审批工作区的修改和所有项目脚本仍要求本机批准；只有本机明确授予 `autoWritable` 的普通文件操作免于 ChatCode 逐项审批。正常关闭管理服务时，会尝试停止只属于 ChatCode Profile 的 runtime；WinCodex Tunnel 不受管理。

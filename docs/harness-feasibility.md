# ChatCode Harness 可行性矩阵

更新时间：2026-10-24。本文区分 ChatCode 能确定性完成的本地执行、ChatGPT Host 的逐轮推理，以及当前尚未验证的平台能力。

## 能力归属

| 能力 | 归属 | 当前可用性与证据 |
| --- | --- | --- |
| 工作区授权、根内文件读取、搜索、分段读取、SHA-256 版本校验 | A：本地确定性 Harness | 已有 MCP 工具；授权只由本机管理页授予。 |
| 项目快照、Git status/diff/log、依赖名称和语言/构建标记 | A | `open_project` 提供有界快照；README.md 和 AGENTS.md 标记为不可信仓库数据。 |
| 精确文本替换、Unified Patch、原始字节分块上传、审批与恢复副本 | A | 写入重新核对工作区和目标版本；审批档位保留；跨文件 patch 不是原子事务。 |
| 测试和构建执行、输出分页、超时、取消与进程树终止 | A，范围受限 | `request_project_check` 支持固定 npm 脚本；`request_allowed_command` 提供固定 Node、Python、Go、Rust 和 .NET 测试/语法命令。没有通用 `run_command` 或任意 argv；所有执行需本机逐项批准。此轮仅 Node 固定命令经过实际执行验证；Go/Rust 依赖离线缓存，.NET 不执行 restore。 |
| 计划、检查代码、选择补丁、分析测试失败、决定是否重试和最终审阅 | B：ChatGPT Host 推理 | `begin_agent_task` 等工具保存 Host 提交的检查点，但服务器不会代替 ChatGPT 推理或主动生成下一步。 |
| 同一用户请求中连续发起多个 MCP 调用 | B/C：由 Host 与平台决定 | MCP 服务器允许连续 `tools/call`；本地 MCP 客户端夹具实测多轮调用。ChatGPT Web 对本项目的多轮闭环尚未实测。 |
| 平台写操作确认、管理员工具 schema 刷新、调用次数/时延/上下文上限 | C：平台独立控制 | ChatCode 不控制这些设置。官方帮助说明 Business、Enterprise 和 Edu 的 ChatGPT Web 支持自定义 MCP；当前 Plugins 体验添加自定义 MCP 不要求先开 Developer Mode。 |
| MCP sampling 或服务端请求模型继续推理 | C：取决于 Host | 不依赖 sampling；ChatCode 不发送模型请求。SDK 协议版本支持不能证明 ChatGPT Host 支持此功能。 |
| ChatGPT 用户请求结束后，服务器自主继续复杂任务 | D：需另一个受支持的模型接口 | 当前未实现，也没有额外模型 API 配置；不能把任务 checkpoint、长时间命令或 OpenCode session 叫作自主 Agent。 |
| OpenCode 自主 Agent / 子代理 | D：需 OpenCode 可用的模型 Provider 与权限集成 | 本机只保留可选 `@opencode/sdk` 会话生命周期检查。没有调用 `sessions.prompt()`，没有复用 Agent loop，也没有复用上游代码。 |
| LSP、结构化语言诊断、项目 Skills、跨目录 AGENTS.md、任意语言命令 | A 的后续能力 | 当前未实现。检测到运行时不代表已有该语言的安全命令或诊断适配器。 |

## 可运行的纵向验证

`npm run test:agent-e2e` 启动隔离的 ChatCode 管理服务与真实 MCP stdio Client，并通过 MCP `tools/list` 和多个 `tools/call` 执行加法 bug 夹具：读取仓库、记录任务计划、运行失败测试、断开并重连 MCP、恢复同一任务、经本机批准应用精确 Diff、再次运行测试、执行有实际输出的语法构建、检查最终 Git Diff，并在暂停工作区时验证后台命令被取消。

本地 Client 自动协商得到 MCP 2026-07-28 modern era。该夹具里的调用顺序和补丁由测试代码预设，只证明 MCP、任务持久化、审批与执行链路可工作；它不是 ChatGPT 模型决定修复方式的证据，也不证明 ChatGPT Web 能在同一用户请求里连续调用工具。

本轮通过连接的 ChatCode 0 MCP 工具执行只读 `list_workspaces` 时，首次收到 `McpServerError: MCP SSE probe returned 429 from openai.org`，后续重试收到 `McpServerError: Session terminated`。连接器工具目录也仍是旧 schema，缺少本地当前注册的 Agent/status 工具。因此官方 Tunnel/连接器真实调用以及 ChatGPT Web 编程闭环未通过验证。没有读取、重建或修改 Tunnel ID、Runtime API Key 或其他本机 Tunnel 状态。官方说明只有有权限管理该应用且连接有效的用户才能刷新工具列表；连接恢复后应由该 workspace 用户按当前 Apps/Plugins 管理界面刷新，再单独执行只读发现和 bug-fix Web 端到端测试。

## OpenCode 复用边界

已审查本地 OpenCode 2.1.4 的 session runner、prompt/context 组装、权限、内置工具、压缩、Skills 和 LSP 相关模块，以及发布版 SDK。Agent loop 把模型/provider 请求与 session 状态、工具调度耦合在一起；它没有一个可直接使用 ChatGPT Web 订阅推理的本地 API。ChatCode 没有移植 OpenCode 私有配置或源码；项目内可选适配器只检查 SDK 的服务/会话生命周期，`promptExecuted=false`。ChatCode 的 Agent task 编排和安全文件/命令边界是本地自实现。

## MCP 协议

当前锁定 `@modelcontextprotocol/server` 2.3.1。ChatCode 使用其 `serveStdio` 工厂入口以兼容现代 `server/discover` 握手和 2025-era `initialize` 握手；协议时代由 Host 的 opening exchange 选择。`get_harness_status` 不能读出单条 MCP 连接最终协商版本。隔离 Client 的自动协商测试记录到 `2026-07-28` / `modern`；传统初始化另由集成测试覆盖。支持协议不等于 ChatGPT Host 已连接或已刷新 schema。

## 官方依据

- [ChatGPT 中连接自定义 MCP 服务器](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [MCP 2026-07-28 架构](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/learn/architecture.mdx)
- [TypeScript SDK 协议版本与协商](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)
- [TypeScript SDK legacy client 服务方式](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md)
- [OpenCode Agent 文档](https://opencode.ai/docs/agents/)
- [OpenCode 源码](https://github.com/anomalyco/opencode)

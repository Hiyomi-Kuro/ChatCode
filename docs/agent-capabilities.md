# ChatCode Agent 能力清单

本页描述当前 MCP server 实际注册并可发现的本地能力。完整 schema 以 `get_tool_catalog` 与 MCP `tools/list` 为准。

## 当前可用

| 类别 | 能力 |
| --- | --- |
| 初始化与发现 | `get_harness_status`、`get_tool_catalog`、`list_workspaces`、`open_project`。状态中不返回根目录绝对路径或 Tunnel 凭据。 |
| 文件上下文 | 分页目录列表、项目结构、文件 stat/哈希、UTF-8 预览、原始字节分块、文件名与文本搜索。 |
| Git | `git_status`、当前 unstaged `git_diff`、最近八条 `git_log`。这些是只读工具。 |
| 修改 | 精确文本替换、文件写入、Unified Patch、目录创建、原始字节分块上传；依工作区权限直写或进入本机审批；SHA-256 版本前置条件和恢复副本按既有流程执行。 |
| 任务 | `begin_agent_task`、`record_agent_plan`、`update_agent_step`、`get_agent_task`、`get_task_context`、`resume_agent_task`、`finish_agent_task`。保存的是 Host 提交的任务检查点。 |
| 项目检查 | `request_project_check`、`run_approved_check`、`request_allowed_command`、`run_approved_command`、`get_task`、`get_task_output`、`cancel_task`。支持固定 npm 脚本，以及固定 `node_test`、`node_check`、`python_test`、`python_compile`、`go_test`、`rust_test`、`dotnet_test` 模板；依赖运行时可用性。每项执行都需要本机批准。 |
| 可观测性 | 本机管理页显示 Agent task、关联本地 job、计划和最近操作摘要；任务输出按页读取并有界保存。 |

## 当前未提供

- ChatGPT Web 的本地推理 API、MCP sampling 依赖、OpenCode Agent prompt 执行或无需用户触发的服务端 Agent loop。
- 通用 `run_command`、任意程序参数、Gradle/Android/Java/CMake build 适配器。Python/Go/Rust/.NET 固定模板尚未在本轮 E2E 中执行验证。
- LSP server、结构化诊断解析、代码索引缓存、跨目录 Skills 或嵌套 AGENTS.md 自动加载。
- Git branch、commit、checkout、reset 等写操作，以及文件删除/重命名工具。
- 经过验证的 Windows 低权限账户、AppContainer、VM 或容器隔离。
- ChatGPT Web 单条用户消息多轮工具循环的真实验证。当前外部连接器调用返回 HTTP 429。

检测到 `java`、`python`、`gradle` 等可执行文件只表示它们在当前环境 PATH 可见，不代表 ChatCode 已为对应语言实现安全命令策略、LSP 或诊断。

Go 和 Rust 模板使用离线模式，.NET test 使用 `--no-restore`；缺少已缓存依赖时会失败，不会自动访问网络。Python 编译会在工作区写入 `__pycache__`；本机审批页显示该命令。固定命令在授权工作区根目录执行，不接受由模型选择的子目录。

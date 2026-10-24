# ChatCode Host-driven Agent 协议

ChatGPT Web 是推理与工具选择方。ChatCode MCP 是本地工具路由和执行面，并持久保存可恢复的任务检查点。服务器没有模型 Provider，也不会在一次工具调用结束后自行询问 ChatGPT 下一步。

## 工具调用工作流

1. `get_harness_status` 查询 ChatCode/MCP 版本、工作区权限、工具环境、固定命令范围和明确未实现的能力；`get_tool_catalog` 返回本次 server instance 实际注册的工具及 annotations。
2. `list_workspaces` 找到已授权工作区，再用 `open_project` 获取有界项目快照。更大的仓库通过 `list_files`、`search_files`、`search_text`、`read_file` 和 `read_file_chunk` 继续分页读取。
3. ChatGPT 根据用户任务调用 `begin_agent_task` 和 `record_agent_plan`。计划内容只是 Host 提交的检查点，不是服务端执行图或授权规则。
4. ChatGPT 逐项读取文件和 Git 状态，选择 `stage_replace`、`stage_file_write` 或 `stage_unified_patch`。`writable` 工作区变更须在本机管理页批准后调用 `apply_change`；`autoWritable` 仅允许其本机授权范围内的普通文件写入。
5. 测试或构建可使用 `request_project_check` 选择固定 npm 脚本，或 `request_allowed_command` 选择 ChatCode 提供的固定 Node/Python/Go/Rust/.NET 操作。本机用户审批后，分别调用 `run_approved_check` 或 `run_approved_command`。命令使用固定 argv、授权工作区根目录和服务端环境变量白名单；没有自由 shell、模型指定 executable、任意参数或自选 cwd。通过 `get_task` 和带 `offset` 的 `get_task_output` 读取真实状态和输出。
6. ChatGPT 读取测试结果并决定下一步。应使用 `update_agent_step` 记录已完成、失败或等待用户批准的计划项。服务器不会将失败自动转成补丁。
7. 验证完成后，ChatGPT检查 `git_status` / `git_diff` 并调用 `finish_agent_task` 记录最终状态。最终摘要是 Host 提交的文字；执行证据来自 Git、任务退出码与输出。

MCP Host 可以在一条用户消息中继续发起多次工具调用，但实际是否继续、能调用多少次以及何时要求用户确认，均由 ChatGPT 平台决定。本地 E2E Client 验证了协议层多轮 `tools/call`，没有模拟 ChatGPT 的推理行为并将其冒充真实网页闭环。

## 持久检查点与恢复

`data/agent-tasks.json` 保存 task ID、workspace ID、用户目标摘要、Host 记录的计划、最近操作摘要和状态。每个请求仍按 workspace ID 重新验证授权。服务器不会保存完整 ChatGPT 对话、隐藏推理或任意仓库快照。

状态分为两层：

| Agent task | 含义 |
| --- | --- |
| `planned` | 已保存目标，等待 Host 规划。 |
| `running` | Host 报告正在执行步骤或触发工具操作。具体进程状态以本地 job 记录为准。 |
| `awaiting_user` | 等待 ChatCode 本机审批，例如项目脚本审批。 |
| `awaiting_model` | 本地调用已返回；等待 ChatGPT 解读结果并决定继续。 |
| `failed` / `cancelled` / `completed` | Host 记录的终态。 |

本地项目命令另有独立 job 状态，例如 `awaiting_approval`、`approved`、`running`、`succeeded`、`failed`、`timed_out`、`cancelled`、`interrupted`。一次命令运行不等于一次 Agent task 完成。

断线或 Host 停止后，使用 `get_agent_task` / `get_task_context` 获取 task 与当前 Git 状态；随后调用 `resume_agent_task` 将非终态任务设为 `awaiting_model`。已关联 job 的 ID 和状态留在 task checkpoint 中；用 `get_task` / `get_task_output` 读取 job 输出。恢复工具只返回证据和状态，不继续推理或执行下一动作。Agent task JSON 在本机持久化，服务器进程间 JSON 更新由锁文件串行化。

管理页面的 Agent tasks 区域通过本机 `/api/agent-tasks` 显示计划、最近状态、job ID 和执行摘要。任务 history 及用户目标是有界文本并经过基本密钥模式脱敏；它们仍可能包含用户/仓库提供的敏感文字，拥有本机数据目录权限的进程可读取。

## 主要限制

- 无 ChatGPT Web 对话历史 API、模型回调或后台自主推进能力。
- 当前命令适配器只运行经过本机逐项批准的固定 npm 脚本或 ChatCode 命令模板；尚无通用 argv runner。本轮仅 Node 命令经过端到端执行验证，其他运行时还需各自 fixture。
- MCP 工具调用与平台写确认仍由 ChatGPT Host 控制。Host 不继续时，任务会留在等待状态，直到用户再次触发 Host 并恢复 checkpoint。
- 本地命令运行于当前 Windows 用户，授权 workspace 的 `cwd` 不是操作系统沙箱。
- 每个 job 输出保留上限 128 KiB；task history 有界；较长命令输出需分页读取。

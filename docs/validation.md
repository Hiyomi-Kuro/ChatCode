# 验证记录

记录真实运行的命令和结果。MCP 本地集成、OpenCode SDK 生命周期、Secure MCP Tunnel 和 ChatGPT 网页端分别记录，不相互代替。

## 调查基线（2026-10-23）

- 本轮开始时当前分支为 `main...origin/main`；`README.md` 已修改，`.gitignore`、`.tmp`、`apps`、`data`、`docs`、npm manifest/lock、`packages`、`scripts`、`tests` 均已有未跟踪内容。它们作为既存工作一并保留；修改前快照位于被忽略的 `.tmp/checkpoints/pre-phase2-20261023/`。
- OpenCode 源码与发布的 `@opencode/sdk` 均为 2.1.4。SDK README 展示 `OpenCode.create()`、`sessions.create()` 和 `sessions.prompt()`。
- 本机运行时：Node.js 24.18.0、npm 11.16.0；未安装 Bun。
- OpenCode、codex-chatgpt-web、WinCodex 三个引用仓库调查时 `git status --porcelain` 均为空。
- 当前会话无法查看 ChatGPT 设置页或账户级自定义 MCP 权限；没有使用或读取 WinCodex Tunnel 凭据。

## 本地实现验证

- 根项目依赖：通过 `npm install --no-audit --no-fund` 安装；MCP SDK 使用 stdio transport。
- 自动化测试：`npm test` 通过，1 个端到端测试，无失败。测试临时目录全部位于 `.tmp/tests`，成功结束后移除。
- 管理页面/API：在测试端口启动真实 `admin.mjs`，验证服务会话、工作区添加/移除、缺失 Origin 拒绝、错误 CSRF 拒绝、变更和任务审批路由。
- MCP stdio：真实 MCP 客户端发现工具并调用授权工作区；验证分页、文本读取和 SHA-256、正则搜索、路径穿越与 `.env` 拒绝、junction/reparse point 和硬链接拒绝（若当前 Windows 禁止创建测试链接，会在测试输出说明）。
- MCP 安全边界：验证 `.git`、`.tmp`、`node_modules` 的显式路径也被拒绝，包含 ChatCode 状态目录的父工作区不能读取或覆盖持久化状态；Git status/diff 可用，敏感文件 Git Diff 被过滤。
- 文件操作：验证文件 Diff 暂存不落盘、通过本机管理 API 的 CSRF 审批后应用、已有文件原子替换、创建文件和目录、两文件 Unified Diff 批次暂存、逐文件审批应用、原文恢复，以及旧哈希时保留用户并发修改并拒绝恢复覆盖。
- 项目检查：验证未审批任务不能运行、批准后固定 `test` 脚本成功返回输出；另一个长任务经 `cancel_task` 取消，任务最终状态为 `cancelled`。
- Windows 文件辅助程序：上述 MCP 用例实际通过 Windows PowerShell 5.1 和 Win32 文件句柄验证路径、列举、元数据、读取、创建、二次哈希校验后的原子替换写入、恢复写入和 mkdir。

## OpenCode SDK

- 初次直接安装 `@opencode/sdk@2.1.4` 的依赖时，`tree-sitter-powershell` 的 `node-gyp-build` 因本机没有可用的 Visual Studio C++ workload 而失败。为避免要求安装额外编译工具，适配器安装命令使用 `--ignore-scripts`。
- `npm run install:opencode` 后，`npm run verify:opencode` 在隔离的 `.tmp/tests` 数据库和目录中成功调用 `OpenCode.create()`、`sessions.create()`、`sessions.get()` 和 `close()`。
- 输出记录了 session ID、创建成功和读取回同一 session；`promptExecuted` 为 `false`。没有配置或读取模型密钥，也没有调用 `sessions.prompt()`，因此 Agent 推理和工具执行未验证。
- npm 对 OpenCode 依赖 `@opentui/core` 报告 Node.js 版本要求 `>=26.4.0` 与 Bun `>=1.3.14`；本机验证时 Node.js 24.18.0 下的会话生命周期可运行，但不据此宣称完整 Agent 兼容。

## Windows 启停与临时清理

- `Start-ChatCode.ps1 -NoBrowser` 实际启动默认管理服务；`GET /healthz` 返回 `status=ok`、绑定地址 `127.0.0.1`，管理页返回 HTTP 200。
- `Stop-ChatCode.ps1` 实际停止服务；随后默认端口健康检查连接失败，证明本机管理服务已关闭。
- `cmd.exe /d /c scripts\Start-ChatCode.cmd` 和 `cmd.exe /d /c scripts\Stop-ChatCode.cmd` 均实际执行成功；启动包装脚本返回后服务健康，停止包装脚本返回后服务关闭。启动 PowerShell 脚本通过 `Start-Process` 使用系统默认浏览器打开管理页。
- 服务运行期间调用 `npm run clean:tmp` 会因活动 PID 锁而拒绝清理；停止服务后再次清理成功。
- `npm run clean:tmp` 成功清空 `build`、`cache`、`sessions`、`tests`、`downloads`、`diagnostics`、`logs`；运行后保留标准 `node_modules` 和空白临时目录结构。
- 最终 `git status --porcelain` 检查中，OpenCode、codex-chatgpt-web、WinCodex 三个上游仓库均保持 clean。

## Secure MCP Tunnel 与 ChatGPT 网页端

- 没有创建 Tunnel：需要用户在 OpenAI Platform 创建 ChatCode 专用 Tunnel，并提供专用 Tunnel ID 和 Runtime API Key。ChatCode 没有读取、保存或复用这些凭据。
- 没有连接 ChatGPT 网页端，也没有验证当前账户/工作区是否有自定义 MCP 应用入口或写工具权限。
- 因此当前结果是“本地管理 API、MCP 协议及测试项目操作已验证”；不是“Secure MCP Tunnel 已连接”或“ChatGPT 网页端已端到端验证”。

## 第二阶段浏览器与连接设置验收（2026-10-23）

- 根因：`index.html` 将含顶层 `await` 的 `admin.js` 当作经典脚本加载，浏览器会在解析阶段抛 `SyntaxError`，整份脚本不会运行，表单事件、CSRF 初始化和连接状态刷新均未注册。表单没有显式 POST 语义，脚本失效时会退回原生表单导航。Tunnel/API 设置也未实现。
- 修复：改为 `type="module"`，服务端明确返回 JavaScript MIME，表单使用 POST，客户端验证 session API 版本、CSRF 和来源后才启用写操作；增加连接状态、错误提示/重试、Tunnel 设置、Windows Credential Manager、MCP 诊断、日志及工作区系统文件夹选择器。
- `npm run test:browser` 通过。使用临时 Edge headless 配置和临时服务/数据完成 17 项浏览器断言：复现经典脚本 SyntaxError、确认修复页无未处理脚本异常/资源失败、session 与列表加载、真实表单 POST/地址栏/等待时禁用重复提交、刷新持久化、重复和父子路径冲突及非法路径提示、访问/暂停/恢复/只读与可写/移除、stdio MCP 实际 `list_workspaces` 调用、官方客户端版本与 Profile 生成及停止态重配、测试密钥 Credential Manager 写入/删除和无明文落盘、缺少凭据时拒绝启动、Tunnel 未连接/ChatGPT 需网页确认，以及网络失败后恢复。报告、连接设置截图与运行日志截图在 `.tmp/tests/admin-browser-evidence/`。
- 测试用的 Runtime Key 是随机占位字符串；通过独立 Credential Manager target 写入后删除。Profile 仅保存 `env:CHATCODE_RUNTIME_API_KEY` 引用。测试工作区授权记录在清理前确认为空；临时工作区、测试数据和 Edge profile 均位于 `.tmp/tests`，测试结束后移除。
- 下载的 OpenAI 官方 `tunnel-client` v0.0.17 Windows amd64 ZIP 与官方 `SHA256SUMS.txt` 匹配；客户端 `--version`、帮助、`init` Profile 和运行时命令均按本机版本验证。官方 `TUNNEL_CLIENT_STATE_DIR` 配置到 ChatCode 自己的 `data/tunnel-client/runtime-home`，本机运行时状态与其他 Tunnel Client 隔离；启动前检查该隔离目录防止重复 Tunnel alias。
- `npm test` 通过：1 个 MCP 集成端到端测试通过，覆盖 Origin/CSRF、防止父子工作区重叠、路径保护、只读和可写授权、Diff 暂存/审批/原子写入/恢复、固定脚本审批执行和取消。
- 启停验证：旧内存服务被新启动脚本识别为 API 版本不匹配；停止后通过 `scripts\Start-ChatCode.ps1 -NoBrowser` 启动新版本。`/healthz` 返回 `127.0.0.1:39721`，`/api/session` 返回 API v2，页面和模块脚本为 HTTP 200 且 JS MIME 正确。重复启动复用同一 PID；停止脚本确认端口关闭和 runtime marker 清除。随后 `Stop-ChatCode.cmd` 与 `Start-ChatCode.cmd -NoBrowser` 均执行成功；最终 ChatCode 服务保持在线。
- 外部 Tunnel 和 ChatGPT：未创建真实 Tunnel，未使用用户的真实 Runtime API Key，也未访问 ChatGPT 登录状态。真实 metadata/doctor、Tunnel runtime、ChatGPT 应用安装/工具发现/网页调用均为“未配置/未验证”；不能用本地 stdio 成功替代这些结果。OpenCode Agent 仍未接入，也未执行模型 prompt。

## 第四阶段：三档授权与原始字节分块（2026-10-24）

- 修改范围：本阶段开始时 `D:\Download\GitHub\ChatCode` 的 Git 工作区干净；本阶段的源码、测试和文档变更仅在该仓库内。MCP 和浏览器测试的数据目录、上传块及稀疏文件夹具均使用 `.tmp/tests` 下的隔离目录；测试结束时自动移除本次隔离夹具。现有浏览器证据仍保留在 `.tmp/tests/admin-browser-evidence/`。没有修改其他仓库、现有授权工作区、Tunnel ID 或 Runtime API Key。
- 工作区模式：MCP 集成验证旧 `writable` 仍创建待审批变更，批准前目标文件不变，批准后应用且可恢复；本机确认后 `autoWritable` 创建、替换、补丁和目录创建直接完成并回报哈希/恢复 ID；暂停与 `readOnly` 状态拒绝写入，MCP 没有授权升权工具。Edge headless 的 `npm run test:browser` 通过，完成 18 项真实浏览器断言，覆盖创建、刷新持久化、逐项审批/免审批/只读切换、暂停/恢复、提交校验阶段提示、确认提示与移除。
- 原始文件：集成测试验证 0 B、1 B、二进制/NUL、UTF-16 BOM、多语言/CRLF、无扩展名，以及 `.exe`、`.dll`、`.apk`、`.zip`、`.rar`、`.7z`、`.pdf`、`.png`、`.jpg`、`.docx`、`.xlsx`、`.pptx`、`.mp3`、`.mp4`、`.db`、`.sqlite` 的原始字节写回。1,048,613 字节文件经多块上传、提交、SHA-256 校验和分块读取完整往返，测试内容 SHA-256 为 `ded6bc08234e6a4aece8ff14ffc2ac1f662602eaed4472146a5a9ac1a738a4a8`。独立稀疏夹具实测大小 `1,073,741,837` 字节，并成功读取 offset `1,073,741,824` 起的 13 字节尾块；未实际传输 1 GiB 内容，也未占用 1 GiB 磁盘空间。
- 上传与游标：覆盖相同幂等键续传、最近块重试、模拟崩溃后截断未确认尾块并续写、乱序/冲突重试、非法 Base64、上传进度、提交校验阶段、权限暂停后拒绝续块、本机取消、文件列表 cursor、同一文件内的文本搜索 cursor、文件名搜索 cursor。自动写入审计事件也由集成测试检查。超时操作可安全重试；哈希/原子发布 PowerShell 辅助调用最长 30 分钟，普通辅助调用 30 秒。
- 自动化结果：最终 `npm test` 通过，1/1 MCP stdio 集成测试、0 失败，历时约 104.5 秒；`npm run test:browser` 通过，18 项断言；本轮改动 JavaScript 的 `node --check` 通过；MCP tools/list 另行确认 `abort_write` 标注为非破坏、可幂等；`git diff --check` 无空白错误（Git 仅提示工作副本 LF/CRLF 转换）。辅助程序样本测量了 canonical-root、文件信息和 SHA-256 三次调用：合计 1,527 ms、平均 509 ms、最大 630 ms、失败 0。该数值是每次 PowerShell 启动与对应文件操作的端到端时间，不是单独进程启动时间。
- 独立连接器检查：ChatCode 0 的只读 `list_workspaces` 显示四个既有工作区；名为 `ChatCode` 的连接器根目录是单独的 Tunnel/探测目录，不是本次 GitHub 源码仓库。已连接的工具目录仍是旧版，未公布 `read_file_chunk`、`begin_write`、`write_chunk`、`commit_write` 等本轮新增工具，因此不能通过该连接器验证本轮新协议。没有向它或 DSH/WakeUP 写入夹具，也没有重启真实服务或 Tunnel。WinCodex 只读访问 D: 授权根，读取了 `.tmp/tests` 中的 69 字符临时交叉核对文本；随后删除了该唯一临时文件。
- 未覆盖的运行边界：没有模拟真实磁盘耗尽、第三方持锁时的文件替换、真实网络断线、并发进程竞争或多 GiB 实际数据传输；上传恢复由相同幂等键和分块重试验证。稀疏文件只验证元数据和尾块读取。`search_text` 是 UTF-8 便利搜索，单文件扫描上限 1 MiB、每次扫描预算 16 MiB；更大的文本仍可通过 `read_file_chunk` 无损读取，但搜索便利工具不扫描单个超过 1 MiB 的文件。ChatGPT 网页端工具发现/确认和真实 Tunnel 往返仍未验证。

## Host-driven Agent Harness P0（2026-10-24）

- 安全起点：本轮开始时源码工作区 clean；先建立本地分支 `codex/harness-p0-checkpoint`，再在 `codex/harness-agent-p0` 实施。没有修改 OpenCode、codex-chatgpt-web、WinCodex、其他授权工作区、DSH/WakeUP、Tunnel 配置或 Runtime API Key。新 E2E 创建并清理的项目都在 `.tmp/tests` 隔离目录。
- MCP 协议：服务器改用 `@modelcontextprotocol/server` 2.3.1 的 `serveStdio` 工厂 dispatcher。Host 可按开场握手选择 2026 modern 或 legacy initialize。集成测试以 Client 默认 initialize 路径成功；Agent E2E 两次自动协商都记录 `2026-07-28` / `modern`。ChatCode 工具 handler 不暴露每条外部连接的协商版本。
- Agent E2E：`npm run test:agent-e2e` 通过，1/1。真实 MCP stdio Client 调用 `tools/list` 与多轮 `tools/call`；测试先观察到 Node 测试退出码 1，断开/重连后恢复同一 task ID，经本机批准只修改 `src/add.js` 中一处减号为加号，复测退出码 0，执行有真实语法检查输出的 build 退出码 0，确认 Git Diff，并验证暂停工作区取消、重复 admin 启动不篡改活跃 job、正常 admin shutdown 先取消后台命令。Agent fixture 内部预设调用次序和补丁；它验证 Harness/MCP 机制，不代表模型自主选补丁或 ChatGPT Web 闭环。
- 全量 Node 测试：最终代码的 `npm test` 通过，2/2、0 失败，总计约 102.8 秒；包括上述 Agent fixture 和既有 MCP stdio 集成/文件安全套件。`tests/mcp.integration.test.mjs` 也曾单独通过 `npm run test:harness` 入口。
- 管理页：最终代码的 `npm run test:browser` 通过，Edge headless 报告 18 项断言，MCP 工具状态显示 39 个本地工具；覆盖管理 API、真实表单、三档工作区、暂停/恢复、Tunnel 设置控件与错误恢复。临时连接凭据由浏览器用例创建并清除；没有使用真实 Runtime API Key。
- 并发与撤权：新增 JSON 状态文件进程间锁，避免 admin 与 MCP worker 读写丢失；取消请求通过持久 task 记录传给 MCP worker，worker 终止子进程树。任务记录关联执行 worker PID；重复 admin 启动检查先于恢复逻辑，并由 E2E 验证重复启动不会更改活跃 job。正常关闭先请求取消 job，再停 ChatCode Tunnel。Agent E2E 也实际运行了暂停工作区撤权取消路径。该锁的多进程压力和管理员强制终止 MCP worker 的恢复未做压力测试。
- 工具/schema：新增 `get_harness_status`、`get_tool_catalog`、`open_project`、task checkpoint、输出分页、Git log 和固定命令模板工具；管理页增加 task timeline。工具 schema 版本为 `2026-10-24.p0.2`。status 不回传绝对路径或凭据，项目说明作为不可信数据。
- 真实连接器：通过已连接的 ChatCode 0 app 调用只读 `list_workspaces`，初次为 `McpServerError: MCP SSE probe returned 429 from openai.org`，重试为 `McpServerError: Session terminated`。远端工具目录仍是旧 schema，不含新 Harness/task 工具。根据 OpenAI 当前帮助，Business/Enterprise/Edu app 管理员可刷新已有工具清单，但必须有管理权限及有效连接；Enterprise/Edu 新动作默认未启用。连接无效时无法完成刷新。未重建 Tunnel、改密钥、运行 Tunnel 或向真实工作区写入测试内容。
- ChatGPT Web 闭环：未验证。缺少可用连接导致无法在 ChatGPT Web 中确认一次自然语言请求是否能驱动多轮工具调用、测试失败后的模型修复决策和最终总结。请勿将本地 E2E Client 或 Edge 管理页测试作为该层证据。
- 固定命令：E2E 新增 `request_allowed_command` / `run_approved_command` 检查。`node_check` 实际运行 `node --check src/add.js` 并通过；任意命令名和逃逸 workspace 的文件路径在 MCP schema/路径校验阶段被拒绝。Python、Go、Rust、.NET 模板受运行时及依赖可用性限制，本轮未执行。所有命令使用固定 argv、授权 workspace 根目录和服务器控制的环境白名单，执行前均需本机审批。
- 未完成范围：没有自由 argv `run_command`，也没有 Gradle/Android/Java/CMake build 模板。没有 LSP、结构化诊断、Skills/嵌套 AGENTS.md、Git 写操作或系统级进程隔离。实现与验证状态见 [`harness-feasibility.md`](harness-feasibility.md) 和 [`agent-capabilities.md`](agent-capabilities.md)。

## ChatCode 本机代理与 Tunnel 验收（2026-10-24）

- 基线网络：`127.0.0.1:9910` TCP 监听可连；通过它请求 `https://api.openai.com/v1/models` 完成 CONNECT、TLS 校验和 HTTP HEAD，返回 401（未发送 API 密钥，代表已到达 OpenAI API）。同一 API 直连在 12 秒限时内超时。原 ChatCode Tunnel 日志此前反复记有 control-plane `network_error` / poll backoff。当前 tunnel-client `0.0.17+a248b7f725fc989c1eb26680cf4351ee33421f61` 支持 `TUNNEL_CLIENT_HTTP_PROXY`；官方说明见 [配置文档](https://github.com/openai/tunnel-client/blob/a248b7f725fc989c1eb26680cf4351ee33421f61/docs/configuration.md) 和 [部署概览](https://github.com/openai/tunnel-client/blob/a248b7f725fc989c1eb26680cf4351ee33421f61/docs/deployment/overview.md)。
- 实际 UI 配置：在 ChatCode 本机 Edge 页面测试代理端口与 OpenAI，之后通过“应用并安全重连”保存 `custom`、`http://127.0.0.1:9910` 和启动自动连接。管理器先验证并停止 ChatCode 自有 runtime，再重连；实时进程路径仍是既有 `D:\Download\tunnel\tunnel-client.exe`。Windows TCP 表确认 ChatCode tunnel-client 与 `127.0.0.1:9910` 建立连接。配置未触及 Runtime API Key、Tunnel ID、工作区权限或其他进程。
- 持久启动：通过 `Stop-ChatCode.cmd` / `Start-ChatCode.cmd -NoBrowser` 实际停止并重启 ChatCode。新服务按保存配置自动启动新的 ChatCode runtime；runtime 报告 `healthy=true`、`ready=true`，管理器记录的活动模式为 `custom`。另一个 codex-chatgpt-web Tunnel 进程在前后保持同一 PID、路径和创建时间。
- 分层结果：代理/OpenAI 检查的 HTTP 401 是无密钥探测的预期结果；ChatCode runtime 本机 healthz/readyz 返回 200，当前管理页 Tunnel 状态 healthy/ready。MCP stdio 从浏览器按钮成功发现工具并调用 `list_workspaces`。客户端 `control_plane_poll_health` 当前为 `unknown`、没有最近成功 poll 时间，因此不能据此确认连续 poll 成功；本机 ready 与 ChatGPT connector 成功是不同证据。
- Metadata / doctor：真实 Runtime API Key 未读取或回显。`doctor` 经本机 UI 完成；Tunnel metadata 请求超时且没有客户端诊断正文，故 metadata 未通过。当前状态安全记录 `lastMetadataError=api_unreachable`，UI 会显示该类别；日志不记录命令参数、Tunnel ID 或密钥。
- ChatGPT connector 层：在最新自动启动的 Tunnel 上，通过现有 ChatCode 0 connector 实际调用 `list_workspaces`、`get_harness_status`、`get_tool_catalog` 和 `read_file` 均成功；目录返回 schema `2026-10-24.p0.2`、39 个工具，并读取授权根内 117 字节的只读 probe 文本。此前的 HTTP 429 / `Session terminated` 没有在这些调用中复现。没有重试创建应用、轮换 Key/Tunnel ID 或刷请求。连接器工具调用已通过；尚未验证 ChatGPT Web 多轮自然语言驱动和失败后修复闭环。
- 自动化验证：最终 `npm test` 通过 7/7；`npm run test:harness` 通过 1/1；Edge headless `npm run test:browser` 通过 22 项断言，覆盖真实代理测试按钮、407 分类、CSRF、预检失败时保留先前配置、配置持久化和本机 stdio MCP 调用。`node --check` 与 `git diff --check` 通过。所有浏览器配置、截图和临时状态均限制于 `.tmp`。

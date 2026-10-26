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

## 第五阶段：Agent 恢复、Android 构建入口与 Calculator（2026-10-24）

- Agent 固定命令：`node_test` 省略路径、`null` 与空字符串现统一规范化；执行定义从固定类型和路径重新推导，并在批准后再次对比保存字段。无 Git 元数据和无提交 Git 仓库可返回上下文并恢复 Agent 检查点；resume 在所有可能失败的上下文收集完成后才提交 revision。跨 MCP worker 状态写入用锁目录与原子 JSON 替换。
- Android harness：增加 SDK/JDK/Gradle/AGP 检查、固定 Gradle task、精确审批预览、Android worker 持久任务、分页日志、取消/重连恢复、Gradle 日志诊断和受限 APK manifest/签名/哈希/原子发布。服务端 MCP 诊断 schema 为 `2026-10-24.android.1`，42 项实际工具注册通过浏览器 E2E 确认。
- 回归：`npm test` 4/4；`npm run test:browser` 18 项浏览器断言；`npm run test:harness` 4/4；`npm run test:agent-e2e` 1/1；修改的 JS `node --check` 和 `git diff --check` 通过。测试耗时和逐项证据见 [`android-harness-validation.md`](android-harness-validation.md)。
- Calculator：使用 ChatCode connector 的真实 workspace 写入、目录创建、文件读取和 `stat_file` 在 `D:\Download\ChatCode\Calculator` 创建 18 个项目文件。Java Views 页面无网络权限；BigDecimal 引擎及 JUnit 测试用例已写入。Gradle wrapper JAR 大小 43,705 字节，MCP stat SHA-256 `81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f`，与只读来源一致。
- Android 真机构建：ChatCode connector 与服务端 tools/list 精确匹配 42/42。经本机批准的 :app:assembleDebug 任务成功（exit 0，34 项任务，1 分 51 秒；Gradle 8.13、AGP 8.13.2、JDK 17、SDK 36）。Artifact 工具校验并发布 D:/Download/ChatCode/Calculator/app-debug.apk，19,534 字节，SHA-256 a92b549e1d6d2f79b5ac8973d136d5173c684d0360472ab184cbe720652024d2；Manifest package com.example.calculator、launcher com.example.calculator.MainActivity、minSdk 23、targetSdk 35，apksigner v1/v2 均通过；ChatCode stat 回读 hash 一致。testDebugUnitTest 已申请本机批准，待批准后运行。

## 第八阶段：无人值守 Harness、Skills、自定义工具与 MuMu（2026-10-25）

- MCP 工具兼容：真实 Edge headless 浏览器 E2E 报告当前服务 `tools/list` 为 63 项；集成测试 fixture 保留原来的 42 个工具名并逐项断言仍可发现。新增项包括只读 Skills 工具、静态自定义工具包目录/状态、项目摘要，以及 Android/MuMu 动作。ChatGPT 网页端与 Secure MCP Tunnel 未连接；平台确认状态未被本地测试绕过。
- 无人值守真实 E2E：隔离 ChatCode workspace 通过本机 CSRF 管理 API 明确授予 `unattendedDev`，连续完成故意失败的 `npm test`、哈希保护修复、复测成功、`assembleDebug`、JUnit、Lint、APK 发布、MuMu 安装和启动；授权范围内没有逐任务待批准记录。Lint 首次失败原因是 `windowLightNavigationBar` 仅 API 27+ 可用，测试只在项目副本中将其迁入 `values-v27` / `values-night-v27` 后重构建，原项目与 APK 保持不变。
- MuMu：CLI 6.6.4.0；选择实际发现的 index `0`，`Kaori Izuki's vivo X100`，Android 12.0，ADB `127.0.0.1:16384`。MuMu `app launch` 偶尔返回成功但未创建 Activity；后端先验证运行状态，再经同一个已选择的 MuMu CLI 调用 APK manifest 已校验的 launcher 作为有界回退。目标 app 位于逻辑 display 24，三轮冷启动与三轮最终检查均观察到 PID、可见 Activity、窗口和 Surface。
- Calculator UI：九项实际 MuMu 检查通过：小数加减乘除 `14.5`、`15.5`、`59.5`、`33.6`，C 清除、除零显示 `Error`、除零后恢复 `42.5`、退格后运算 `16.5`、AC 清屏。Windows OCR 读取目标显示区域；零值通过与同一 app 在 AC 后的显示区域 SHA-256 比较确认。第一张加法截图位于 [screen-2026-10-24T17-46-38-595Z-9a8e332c-cadb-4e3b-8fd7-0a7aa5136554.png](../.tmp/tests/ws-e9bab825/workspace%20with%20spaces/Calculator/.tmp/mumu/screen-2026-10-24T17-46-38-595Z-9a8e332c-cadb-4e3b-8fd7-0a7aa5136554.png)。
- 构建 APK：隔离副本 package `com.example.chatcode.calculator.acceptance.r80791c2e64aa`，22,488 bytes，SHA-256 `0b7b1cc133e86d3b86236115fb1a6d2bff9ea3c39af3365ad9c797dd072b354e`。本次检查前后原 `D:\Download\ChatCode\Calculator` 源树 SHA-256 均为 `95d5b8e3c08d57aee9bfaed3144b468009097b58515cf2a89b4a338215fb8439`；原项目 `app-debug.apk` 和 `artifacts/app-debug.apk` 均仍为 SHA-256 `a92b549e1d6d2f79b5ac8973d136d5173c684d0360472ab184cbe720652024d2`。
- UI tree 与日志：MuMu 的 `dump_ui_hierarchy` 没有返回有效 XML，因此此运行没有通过语义 hierarchy 验收；截图 OCR 是显示证据，不能替代 hierarchy。过滤后的本次 app Logcat 为 0 行，crash diagnostics 为 `crash_detected=false`。完整状态、任务日志摘要、授权审计、APK 和截图哈希见 [acceptance-evidence.json](../.tmp/tests/mumu-calculator-2026-10-24T17-23-26-762Z-1fd92246-f553-4688-8170-593a6219f88f/acceptance-evidence.json)。
- 回归：`npm test` 8/8；`npm run test:browser` 18 项断言；`npm run test:harness` 首次 MCP 恢复 API 返回一次未复现的 HTTP 400，加入错误响应正文后单独 MCP 集成通过 1/1，随后完整 harness 重跑 8/8；`npm run test:agent-e2e` 1/1。单独 E2E 与集成测试使用隔离 `.tmp/tests` 数据，保留机器可读证据。
- 未覆盖项与限制：文件/目录 copy/move/rename/回收站式删除、托管 LSP server 生命周期和完整诊断/符号 API、ripgrep/增量符号索引、Git commit/worktree 等写操作、带依赖/重试的完整 Agent DAG 尚未实现；文本搜索仍受单文件 1 MiB 和每次 16 MiB 扫描预算限制。当前没有 Windows Sandbox/AppContainer 等 OS 隔离；无人值守 npm/Gradle 代码仍以当前 Windows 用户身份运行。UI hierarchy、真实 Tunnel 与 ChatGPT 网页工具确认不能据此宣称已验证。

## 第九阶段续建验收（2026-10-25）

- 工作区：继续同一 `D:\Download\GitHub\ChatCode` 工作树，开始前创建 `.tmp/checkpoints/phase9-pre-work-20261025.zip` 和 `.tmp/checkpoints/phase9-pre-work-20261025.txt`。没有执行 reset/clean；Calculator、Codex Skills 原件、全局权限与 Windows 功能配置未改。
- A0 新鲜 MCP 子进程：完成 MCP initialize，`tools/list` 为 92 项；旧 63 个 Phase 8 名称和 `tests/legacy-mcp-tools.json` 的 42 个最初名称全部保留，新增 29 项，`get_tool_catalog` 与 tools/list 完全一致。真实调用 `list_workspaces`、`get_lsp_status`、`get_code_search_status`、`get_git_runtime_status` 成功。结果见 `.tmp/phase9/a0-mcp-canary.json`。
- A0 连接层：管理服务 `/healthz` 返回 `ok`，`127.0.0.1:39721`、API v2、PID 27228。`/api/tunnel/status` 只读调用返回 connected/running/healthy/ready，客户端 0.0.17+a248b7f725fc989c1eb26680cf4351ee33421f61；这只验证本机状态。通过已连接 ChatCode 0 插件重新调用 `get_harness_status`、`get_tool_catalog`、`list_workspaces`，三项都返回 `McpServerError: Session terminated`，JSON-RPC 32600，连接器仍只公开 42 项。Tunnel MCP 往返及 ChatGPT 网页发现/真实调用为 `NOT_VERIFIED`。未重启现有用户服务，以避免中断。
- A1 文件生命周期：`npm run test:file-ops` 通过，1/1，223.5 秒，真实 Win32/MCP 文件与目录流程。覆盖中文/空格路径、二进制 SHA-256、目录 copy、幂等重试、重名/重叠拒绝、批次回滚、move、仅大小写 rename、持久软删/restore、缺少 `fileLifecycle` 授权、越界和 junction。哈希及操作 IDs 见 `.tmp/phase9/a1-file-ops-evidence.json`。后续 `npm test`、`test:harness` 再次通过相同流程。
- A2/A3：真实 TypeScript Language Server 6.0.2 / TypeScript 6.0.3 的 definition、references、hover、文档和 workspace symbols、类型错误诊断均通过；Java/Kotlin/Python 服务器未安装，工具返回 unavailable。Ripgrep MCP 在非 Git 中文/空格 fixture 上验证忽略规则、二进制排除、超 1 MiB 文本、大文件尾部命中、glob、上下文和分页。证据见 `.tmp/phase9/a2-lsp-evidence.json`、`a3-ripgrep-evidence.json`。
- 正则超时专项：对 `boundedRegexMatches` 输入 `(a+)+$` 与 100,000 个 `a` 后跟 `b`，真实 Worker 在 2,004 ms 被终止并返回超时诊断；见 `.tmp/phase9/a3-regex-timeout-evidence.json`。
- A4 Git：`npm run test:git-write` 通过，1/1，118.4 秒，真实隔离 Git 仓库并经 MCP 执行。确认预览 diff/author、旧文件版本与移动 HEAD 拒绝、仅提交列明文件、保留用户暂存的其它文件、幂等重试、敏感路径拒绝、禁用 worktree hooks、脏 worktree 拒删、干净的 ChatCode worktree 可删且分支保留。Git 版本/哈希和测试 commit ID 见 `.tmp/phase9/a4-git-evidence.json`。
- A5 DAG：独立 DAG 测试和 MCP Agent E2E 通过，验证环/悬空依赖拒绝、依赖门控、冲突资源锁、并行上限 3、限次 transient 重试、输入与 artifact 哈希、持久 timeline/output/idempotency key，以及非 Git 跨进程恢复。证据 `.tmp/phase9/a5-agent-dag-evidence.json`。
- A6/A7：A6 首次检查因 QQ 音乐位于逻辑 display 2 而阻塞，历史记录保留；用户确认其已离开前台后，重新发现唯一 MuMu Android 12 实例并复用已安装隔离 Calculator。独立 UiAutomator 探针启用 `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` 后，读取到 display 6 上 active/focused 的 Calculator 窗口，目标包有 32 个去重节点、22 个文本节点、20 个按钮；关键键齐全，bounds 位于 1080×1920 屏幕内。没有安装/卸载 APK，也没有改动原始 Calculator。通用 `dump_ui_hierarchy` 后端未修改，仍未声称其已支持次级 display。证据见 `.tmp/phase9/a6-mumu-evidence.json`、`.tmp/phase9/a6-mumu-resume-evidence.json`、`.tmp/phase9/a6-mumu-resume-hierarchy.xml`。Windows 11 Home 未找到 Windows Sandbox，DISM 检查需提升权限；未提升或改系统设置，A7 仍为 `BLOCKED/NOT_AVAILABLE`，见 `.tmp/phase9/a7-sandbox-evidence.json`。
- 浏览器和回归：`npm run test:browser` 使用真实 Edge headless，通过 18 项断言；诊断页面正确显示本机 MCP 92 项并把 Tunnel/ChatGPT 状态分开。最终 `npm test` 为 13/13，0 失败，327.9 秒；`npm run test:harness` 为 13/13，0 失败，287.7 秒；`npm run test:agent-e2e` 为 2/2，29.5 秒。
- 回归过程的实际失败和修复：首轮 `npm test` 12/13，唯一失败是 unattendedDev 测试仍期待 `android.2` schema；改为核验 `2026-10-25.phase9.4` 后单测通过。次轮 12/13，旧正则 worker 500 ms 超时包含了并发 worker 启动时间，普通 regex 被误杀；提高到仍有界的 2 秒并输出失败详情，单独 MCP 集成 1/1 通过，然后最终 npm test 全绿。没有跳过或删除失败测试。
- 静态检查：`node --check` 覆盖 31 个修改/新增 JavaScript 文件，通过；`package.json`、`package-lock.json`、`tests/legacy-mcp-tools.json` 均解析通过；`git diff --check` 通过，只有 Git LF/CRLF 提示。活动服务保持运行，未做关闭测试或打断现有 Tunnel。
- 故障注入边界：本轮没有模拟断电/磁盘耗尽/外部持锁/跨卷写入；LSP E2E 没有强制杀死 server、注入坏 framing 或验证取消；DAG 未模拟机器断电中写持久日志或步骤中撤销授权。这些场景不得算真实故障恢复 PASS。LSP 的实测能力限于真实 TypeScript server 的请求、诊断和工作区快照边界。

## 第十阶段：Geph 代理、Secure MCP Tunnel 与启停验收（2026-10-25）

- 配置与隔离：ChatCode 保存的代理为 HTTP `http://127.0.0.1:9910`。代理变量仅注入 ChatCode 专属 `tunnel-client` 子进程；Tunnel MCP wrapper 清除代理变量和 Runtime API Key。没有修改 Windows 全局代理、hosts、防火墙、其他 Tunnel 或真实 Credential Manager 凭据。既存 Git 未提交改动保留；临时浏览器测试凭据使用独立 target，结束后已删除。
- Windows 生命周期验收：运行 `node tests/windows-lifecycle.acceptance.mjs`，六次 `Start-ChatCode.cmd` / `Stop-ChatCode.cmd` 调用均以退出码 0 完成。重复 Start 复用同一个 admin PID；新鲜 stdio MCP `initialize`、`tools/list` 和 `list_workspaces` 诊断通过，共发现 92 项工具。保存代理下 TCP 探测可达；不带 Key 的 OpenAI API HEAD 返回 HTTP 401，表示到达 API，不表示鉴权成功。Tunnel 健康状态包含成功的控制平面 poll。
- 故障与恢复：临时将隔离验收中的 ChatCode 代理设置指向已关闭的 loopback 端口，状态变为 `waiting_proxy`，且没有启动 Tunnel 进程或直连回退。恢复保存的 `9910` 后，自动探测和重试恢复 Tunnel，控制平面 poll 再次成功。连续两次 Stop 后项目 admin/Tunnel 进程退出；此前存在的外部 Tunnel PID `8020` 前后保持不变。机器证据见 [`acceptance-2026-10-25T12-21-39.429Z.json`](../.tmp/tests/windows-lifecycle/acceptance-2026-10-25T12-21-39.429Z.json) 和同目录进度日志。该验收由 `cmd.exe` 调用包装脚本模拟双击命令；没有自动化 Explorer 图形界面或 Windows 注销/重启。
- 回归：`npm test` 20/20；`npm run test:browser` 18 项 Edge headless 断言；`npm run test:harness` 13/13，均通过。浏览器首跑的停止提示断言沿用旧文案，更新为匹配 API 当前的“Tunnel 已断开”后重跑通过。浏览器报告和截图见 `.tmp/tests/admin-browser-evidence/`。`git diff --check` 与脚本静态解析在本阶段变更后复核。
- 外部平台边界：本阶段没有创建或删除 ChatGPT 应用，也没有访问 ChatGPT 网页端。因此 92 项是本机 stdio MCP 工具数；远端 Tunnel MCP 往返、ChatGPT 工具发现和网页真实调用仍未验证。浏览器诊断如实显示 ChatGPT“需网页确认”。

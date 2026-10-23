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

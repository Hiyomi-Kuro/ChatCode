# ChatCode

ChatCode 是一个 Windows 本地 MCP 服务，让 ChatGPT 网页版在用户授权的项目目录中读取代码、查看 Git 状态、预览修改、执行已批准的改动，以及运行受限的异步项目任务。

## 当前状态

本仓库提供本机管理页、MCP stdio 工具、Windows 文件句柄安全辅助程序和分块文件传输。工作区权限仍分为只读、逐项审批可写和免逐项审批文件写入；另有本机一次配置的 `unattendedDev` 执行范围，可授权已存在且哈希绑定的 npm 脚本、固定命令、限定 Android Gradle 任务，以及一个经 MuMu CLI 实际发现并选中的实例。旧工作区不会自动升权。任意文件格式通过原始字节分块读写；`data/changes.json` 保存小型审批元数据，大文件正文位于 `.tmp/uploads`。授权命令和 Gradle 构建仍以当前 Windows 用户身份运行；本机没有实现 OS 沙箱，项目 cwd 或独立缓存不构成沙箱。任意 Shell 不开放。详见 [`docs/unattended-harness.md`](docs/unattended-harness.md)。

ChatGPT 自定义 MCP 应用当前支持读和写工具，但能否在某个账号或工作区创建、安装和运行仍受账户、工作区角色及管理员限制。本机无法从本次 Codex 会话读取 ChatGPT 设置，因此当前账号的实际权限尚未验证。连接步骤和准确限制见 [`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md)。

Phase 9 增加了有恢复日志的文件 copy/move/rename/软删除事务、隔离快照中的 TypeScript/JavaScript LSP、真实本地 ripgrep 检索、显式预览后 Git commit/专属 worktree，以及有依赖、限次重试、资源锁和跨会话状态的 Agent DAG。破坏性文件操作和 Git 写入需要本机在 `unattendedDev` 中分别选择 `fileLifecycle`、`gitWrite`；旧工作区不会自动得到这些权限。ChatGPT 仍是唯一推理宿主，Tunnel/网页端工具发现需要单独验证；阶段进展见 [`docs/phase9-resume-report.md`](docs/phase9-resume-report.md)，代理与 Windows 启停的最新实测见 [`docs/validation.md`](docs/validation.md)。

## 环境

- Windows 10/11
- Node.js 24 或更高版本
- npm（随 Node.js 提供）
- PowerShell 5.1 或更高版本
- 可选：OpenAI 官方 `tunnel-client` Windows 二进制、用户单独创建的 Tunnel ID 和 Runtime API Key

Bun 当前未安装；ChatCode 使用 Node.js。OpenCode SDK 使用独立的可选 npm 包目录，不会在 OpenCode 仓库里安装依赖或产生文件。当前适配器只验证 SDK 主机和会话生命周期；它还没有把 OpenCode Agent 接入 ChatCode MCP 或本机审批流程。

## 安装和启动

首次安装依赖（npm 下载缓存固定在项目 `.tmp`）：

```powershell
Set-Location D:\Download\GitHub\ChatCode
$env:npm_config_cache = "$PWD\.tmp\cache\npm"
npm install --no-audit --no-fund
```

之后可以双击 [`scripts\Start-ChatCode.cmd`](scripts/Start-ChatCode.cmd) 启动服务并用系统默认浏览器打开管理界面；启动完成后命令窗口会自动关闭。需要 PowerShell 界面时，也可以双击 [`scripts\Start-ChatCode.ps1`](scripts/Start-ChatCode.ps1)。

Secure MCP Tunnel 默认使用已保存的 Geph HTTP 代理 `http://127.0.0.1:9910`。首次配置 Tunnel 时，在“连接设置”填写专属 Tunnel ID、客户端位置和 Runtime API Key，并确认代理模式为“迷雾通 HTTP 代理”、地址为 `http://127.0.0.1:9910` 后保存。旧配置会迁移到此默认值；已有有效显式代理地址会保留。日常使用时只需让 Geph 保持运行并双击 Start/Stop，不需要为 CMD、PowerShell、Node 或 npm 手动设置代理环境变量。

如果 Geph 或 9910 暂不可用，ChatCode 管理页和本地 MCP 仍可启动；Tunnel 状态会显示等待代理，强制 HTTP 模式不会尝试直连，并会以 5 秒起步、最长 120 秒的退避间隔自动重试。代理恢复后会自动重新探测并连接。连接设置页可分别测试代理 TCP 和经代理的 OpenAI API。管理服务启动失败时，CMD 会保留窗口显示错误；详细脱敏日志在 `.tmp/logs/start-*.ndjson`、`.tmp/logs/stop-*.ndjson` 和对应的 admin stdout/stderr 文件中。Tunnel/API 429、控制平面故障和 ChatGPT 平台工具发现分别报告，不会仅凭本地进程存活显示远端已连接。

在 PowerShell 执行：

```powershell
npm start
```

停止服务可双击 [`scripts\Stop-ChatCode.cmd`](scripts/Stop-ChatCode.cmd)；命令窗口会在停止后自动关闭。也可双击 [`scripts\Stop-ChatCode.ps1`](scripts/Stop-ChatCode.ps1)，或关闭运行 `npm start` 的终端。MCP stdio 子进程由 Secure MCP Tunnel 按需启动，不需要单独启动。

## 授权工作区

1. 打开本地管理页面。
2. 输入本机项目目录的完整路径，选择只读、逐项审批写入或免逐项审批写入，然后点“添加工作区”。
3. 仅通过该页面添加的目录才会暴露给 MCP。模型不能通过工具参数增加根目录。
4. 逐项审批模式中，ChatGPT 调用 `stage_file_write`、`stage_unified_patch` 或分块上传后，本机用户检查并批准，再调用 `apply_change`。免逐项审批模式直接执行普通文件创建、覆盖、文本替换、补丁和目录创建，并返回 SHA-256 与实际状态。ChatGPT 平台的写操作确认仍照常生效。
5. 小文件可调用 `write_file`；大文件使用 `begin_write` → 重复 `write_chunk` → `commit_write`。`read_file_chunk` 按字节读取，单块最多 262144 字节；文件总大小没有应用层 1 MiB 上限。逐项审批的大文件正文和恢复副本使用 `.tmp/uploads` 文件，不会塞入 `data/changes.json`。多文件补丁逐个写入并报告结果及恢复 ID，不是一个原子事务。
6. 默认仍采用本机逐项审批。若需要无人值守，在该工作区卡片中一次配置 `unattendedDev`，逐项选择已存在的 npm scripts、固定命令、Android 项目/Gradle 任务、Git 只读能力、可选的受控 Git commit/worktree、文件生命周期权限和当前已发现的 MuMu 实例。Git 写入与 copy/move/rename/软删除需再次单独确认；后续同一范围的任务返回持久 task/transaction ID，可查看结果或撤销授权。平台侧 ChatGPT 确认仍可能出现。
7. Android 项目可调用 `get_android_environment` 检查 SDK、JDK 和 Gradle，再请求 `assembleDebug`、`testDebugUnitTest` 或 `lintDebug`。成功构建后仅发布并校验本次生成的 APK。MuMu 工具发现、安装、启动、日志、截图和 UI hierarchy 都绑定到本机选定实例及本工作区发布的 APK。真实 Calculator 验收命令为 `npm run test:mumu`，会在 `.tmp/tests` 复制项目并控制已发现的 MuMu；它可能安装测试 APK，所以不要在使用中的 VM 上执行。详见 [`docs/android-harness-design.md`](docs/android-harness-design.md) 和 [`docs/mumu-acceptance.md`](docs/mumu-acceptance.md)。
8. Skills 与自定义工具分置于只读 Codex Skills Provider 和源码控制的 `tools/<package-id>/manifest.json`。Skills 内容是不可信参考文本，工具包代码只从 registry 静态 allowlist 导入；详见 [`docs/skills-and-custom-tools.md`](docs/skills-and-custom-tools.md)。
9. `get_lsp_status` 报告真实可用的 LSP；当前提供 TypeScript/JavaScript 服务，隔离快照不允许项目内 LSP 进程修改授权源文件。`search_code` 使用已安装且校验哈希的 `rg.exe`，并提供资源受限分页与取消。两项都不是自然语言语义搜索。
10. Git 写入先调用 `git_preview_commit` 查看作者、message、明确文件的 Diff 和版本，再用预览哈希和 `request_id` 调用 `git_commit`。本机必须另选 `gitWrite`。worktree 由 ChatCode 生成并登记，只能移除无改动的托管 worktree；工具没有 push/force/reset/clean。
11. 文件 copy/move/rename/软删除按清单哈希执行，删除进入持久恢复区；`apply_file_operations` 提供有序 journal 与补偿结果。跨文件、跨卷复制不是物理原子操作。

OpenCode、codex-chatgpt-web 和 WinCodex 三个参考仓库，以及它们的父目录，都不能作为 ChatCode 工作区。

## 接入 ChatGPT

ChatCode MCP 通过 stdio 运行。OpenAI 官方 `tunnel-client` 会在本机启动该 MCP 子进程，并以出站 HTTPS 转发请求；本机不开放公网入站端口。需由用户从 OpenAI Platform Tunnel 页面下载官方客户端、创建或选择独立 Tunnel，并使用专用 Runtime API Key。不要复制 WinCodex 的 Tunnel ID、密钥或运行配置。

管理页“连接设置”支持本机 stdio MCP 检查、官方客户端检测、Profile 生成、Credential Manager 密钥存取、metadata/doctor 和受控 Tunnel 启停。专用 Tunnel ID、Runtime API Key 与 ChatGPT Apps 注册仍需用户在官方页面完成；没有密钥时，工作区和本机 MCP 测试仍可使用。逐步配置及账号权限边界见 [`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md)。

## 可选 OpenCode SDK 检查

如需复核发布版 SDK 的嵌入式会话 API：

```powershell
npm run install:opencode
npm run verify:opencode
```

依赖安装隔离在 `packages/opencode-adapter`，并跳过上游包的安装脚本。当前验证在 Node.js 24.18.0 上成功创建、读取并关闭 OpenCode 2.1.4 会话；它没有配置模型、发送 prompt 或修改项目。OpenCode 依赖树对 `@opentui/core` 给出 Node.js 26.4.0 / Bun 1.3.14 的引擎警告，完整 Agent 执行尚未在本机验证。

## 验证与临时文件

```powershell
npm test
npm run test:browser
npm run test:harness
npm run test:agent-e2e
npm run test:git-write
npm run clean:tmp
```

需要执行真实 Android/MuMu 端到端验收时，单独运行 `npm run test:mumu`。该命令会在 ChatCode `.tmp/tests` 建立隔离工作区，运行 npm 测试、Gradle 构建/JUnit/Lint、安装 APK 到唯一已选 MuMu、执行 UI 按键并留存证据。它不属于默认 `npm test`，因为会控制模拟器。

`test:browser` 使用独立临时数据目录和 Edge headless 配置，通过 DevTools 协议实际点击表单、只读/逐项审批/免逐项审批权限按钮及设置页控件。测试报告和截图写入 `.tmp/tests/admin-browser-evidence`。

运行时和测试临时文件放在项目 `.tmp` 下；`clean:tmp` 只清理白名单临时子目录，不删除 `data`、凭据、源代码或仍在运行的服务。npm 依赖使用标准 `node_modules`，可在确认 ChatCode 停止后手动删除并重新执行 `npm install`。

## 架构与安全

- [`docs/architecture.md`](docs/architecture.md)：模块边界、默认 ChatGPT 原生 MCP 路径与 OpenCode Agent 集成状态。
- [`docs/security.md`](docs/security.md)：目录边界、敏感文件、修改审批、命令审批与审计记录。
- [`docs/validation.md`](docs/validation.md)：逐项记录已执行的本地测试和未验证的外部依赖。
- [`docs/unattended-harness.md`](docs/unattended-harness.md)：无人值守授权、范围、任务状态和取消说明。
- [`docs/skills-and-custom-tools.md`](docs/skills-and-custom-tools.md)：本地 Skills Provider 与工具包注册步骤。
- [`docs/mumu-acceptance.md`](docs/mumu-acceptance.md)：MuMu 工具、安全约束和真实 Calculator 验收报告。
- [`docs/phase9-resume-report.md`](docs/phase9-resume-report.md)：第九阶段本轮实现、证据、回归结果及仍未验证的外部边界。

ChatGPT 网页模型负责自然语言推理；MCP 工具只执行它提出且通过本机授权的具体操作。这条默认路径不调用额外模型 API。OpenCode Agent 目前不是可用执行模式：可选 SDK 检查能创建并读取本地会话，但没有执行 `sessions.prompt()`；真正运行 Agent 需要 OpenCode 模型供应方和进一步的本机权限审批集成。

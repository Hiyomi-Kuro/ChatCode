# ChatCode

ChatCode 是一个 Windows 本地 MCP 服务，让 ChatGPT 网页版在用户授权的项目目录中读取代码、查看 Git 状态、预览修改、执行已批准的改动，以及运行经过本机确认的项目检查。

## 当前状态

本仓库提供本机管理页、MCP stdio 工具、Windows 文件句柄安全辅助程序和分块文件传输。工作区可设为只读、可写并逐项审批，或由本机用户单独确认后可写且无需 ChatCode 本机逐项审批。任意文件格式通过原始字节分块读写；`data/changes.json` 保存小型审批元数据，大文件正文位于 `.tmp/uploads`。固定项目脚本、白名单 Node/Python 检查和 Android Gradle 任务都要求独立本机审批。ChatGPT 账号、工作区权限、OpenAI Tunnel ID 和 Runtime API Key 必须由用户在各自官方页面配置；ChatCode 不会读取或复用 WinCodex 的凭据。

ChatGPT 自定义 MCP 应用当前支持读和写工具，但能否在某个账号或工作区创建、安装和运行仍受账户、工作区角色及管理员限制。本机无法从本次 Codex 会话读取 ChatGPT 设置，因此当前账号的实际权限尚未验证。连接步骤和准确限制见 [`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md)。

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
6. 项目命令同样先生成待审批任务；本机确认后才可启动。工具只接受 `test`、`build`、`lint`、`typecheck` 或 `check` 这些固定脚本名。
7. Android 项目可先调用 `get_android_environment` 检查 SDK、JDK 和 Gradle，再请求 `assembleDebug`、`testDebugUnitTest` 或 `lintDebug`。本机管理页显示固定 runner、参数、输入哈希、隔离缓存位置和风险；批准后 MCP 才能启动可恢复、可取消的 Gradle worker。成功的 `assembleDebug` 只有通过 APK manifest、包名、启动 Activity、SDK 字段和签名校验后才发布为项目内 `app-debug.apk`。详见 [`docs/android-harness-design.md`](docs/android-harness-design.md)。

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
npm run clean:tmp
```

`test:browser` 使用独立临时数据目录和 Edge headless 配置，通过 DevTools 协议实际点击表单、只读/逐项审批/免逐项审批权限按钮及设置页控件。测试报告和截图写入 `.tmp/tests/admin-browser-evidence`。

运行时和测试临时文件放在项目 `.tmp` 下；`clean:tmp` 只清理白名单临时子目录，不删除 `data`、凭据、源代码或仍在运行的服务。npm 依赖使用标准 `node_modules`，可在确认 ChatCode 停止后手动删除并重新执行 `npm install`。

## 架构与安全

- [`docs/architecture.md`](docs/architecture.md)：模块边界、默认 ChatGPT 原生 MCP 路径与 OpenCode Agent 集成状态。
- [`docs/security.md`](docs/security.md)：目录边界、敏感文件、修改审批、命令审批与审计记录。
- [`docs/validation.md`](docs/validation.md)：逐项记录已执行的本地测试和未验证的外部依赖。

ChatGPT 网页模型负责自然语言推理；MCP 工具只执行它提出且通过本机授权的具体操作。这条默认路径不调用额外模型 API。OpenCode Agent 目前不是可用执行模式：可选 SDK 检查能创建并读取本地会话，但没有执行 `sessions.prompt()`；真正运行 Agent 需要 OpenCode 模型供应方和进一步的本机权限审批集成。

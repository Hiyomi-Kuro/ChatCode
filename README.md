# ChatCode

ChatCode 是一个 Windows 本地 MCP 服务，让 ChatGPT 网页版在用户授权的项目目录中读取代码、查看 Git 状态、预览修改、执行已批准的改动，以及运行经过本机确认的项目检查。

## 当前状态

本仓库从空项目开始实现，当前交付聚焦于可运行的本地 MVP：管理界面和多工作区授权、MCP stdio 工具、Windows 文件安全辅助程序、两阶段文件修改审批、Unified Diff 批次暂存与恢复、白名单项目脚本任务、操作日志及集中临时目录。ChatGPT 账号、工作区权限、OpenAI Tunnel ID 和 Runtime API Key 必须由用户在各自官方页面配置；ChatCode 不会读取或复用 WinCodex 的凭据。

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
2. 输入本机项目目录的完整路径，选择只读或可写，然后点“添加工作区”。
3. 仅通过该页面添加的目录才会暴露给 MCP。模型不能通过工具参数增加根目录。
4. 需要写文件时，先在 ChatGPT 中调用 `stage_file_write` 或 `stage_unified_patch` 生成预览，再在本机管理页逐项检查并批准，最后调用 `apply_change`。已有文件逐个通过 Windows 原子替换写入；多文件补丁逐个批准和应用，不是一个原子事务。
5. 项目命令同样先生成待审批任务；本机确认后才可启动。工具只接受 `test`、`build`、`lint`、`typecheck` 或 `check` 这些固定脚本名。

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
npm run clean:tmp
```

`test:browser` 使用独立临时数据目录和 Edge headless 配置，通过 DevTools 协议实际点击表单、工作区权限按钮及设置页控件。测试报告和截图写入 `.tmp/tests/admin-browser-evidence`。

运行时和测试临时文件放在项目 `.tmp` 下；`clean:tmp` 只清理白名单临时子目录，不删除 `data`、凭据、源代码或仍在运行的服务。npm 依赖使用标准 `node_modules`，可在确认 ChatCode 停止后手动删除并重新执行 `npm install`。

## 架构与安全

- [`docs/architecture.md`](docs/architecture.md)：模块边界、默认 ChatGPT 原生 MCP 路径与 OpenCode Agent 集成状态。
- [`docs/security.md`](docs/security.md)：目录边界、敏感文件、修改审批、命令审批与审计记录。
- [`docs/validation.md`](docs/validation.md)：逐项记录已执行的本地测试和未验证的外部依赖。

ChatGPT 网页模型负责自然语言推理；MCP 工具只执行它提出且通过本机授权的具体操作。这条默认路径不调用额外模型 API。OpenCode Agent 目前不是可用执行模式：可选 SDK 检查能创建并读取本地会话，但没有执行 `sessions.prompt()`；真正运行 Agent 需要 OpenCode 模型供应方和进一步的本机权限审批集成。

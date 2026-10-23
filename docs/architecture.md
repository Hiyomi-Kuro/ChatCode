# ChatCode 架构

## 组件

- `apps/server/admin.mjs`：只绑定 `127.0.0.1` 的本地管理页和 JSON API。目录授权及待执行变更审批只由此入口修改。
- `apps/server/ui/`：模块脚本初始化本机 CSRF 会话后才启用写操作；状态页分别显示 HTTP、MCP stdio、Tunnel 与 ChatGPT 网页端。
- `apps/server/core/tunnel.mjs`：调用官方 `tunnel-client` 检测、生成 Profile、读取 Tunnel metadata、运行 doctor 以及管理本机 runtime；Runtime API Key 由 Windows Credential Manager 提供。
- `scripts/credential-store.ps1` 与 `scripts/select-folder.ps1`：分别用于当前 Windows 用户的 Credential Manager 和用户明确操作的系统文件夹选择器。
- `apps/server/mcp.mjs`：MCP stdio 服务，由 OpenAI 官方 Secure MCP Tunnel 启动。MCP 参数不包含新增授权目录的能力。
- `apps/server/core/safe-fs.mjs` 与 `scripts/safe-fs.ps1`：严格解析根内相对路径；Windows 辅助程序使用句柄、最终路径和 reparse 属性检查执行文件操作。
- `apps/server/core/workspaces.mjs`：独立 workspace ID、暂停/恢复、只读/可写状态及参考仓库排除规则。
- `apps/server/core/changes.mjs`：按文件版本哈希暂存修改、生成统一 Diff、本机批准后再应用。
- `apps/server/core/tasks.mjs`：固定项目脚本名、任务 ID、审批、状态轮询和取消。
- `packages/opencode-adapter/adapter.mjs`：可选 OpenCode SDK 生命周期检查；不参与 ChatGPT 原生 MCP 的推理，也不改写上游代码。
- `data/`：授权、待审批更改、任务元数据和脱敏审计事件。
- `.tmp/`：可清理的缓存、日志、测试目录和短时运行状态。

## 推理和执行模式

### A. ChatGPT 原生 MCP（默认）

ChatGPT 网页版模型完成需求分析与编程决策。模型调用 ChatCode MCP 工具来列举、读取、搜索、暂存修改或请求固定项目检查。真实文件写入和项目脚本执行都要先经过本机管理页批准；服务器端会重新校验 workspace 状态、路径、版本哈希和批准状态。

该路径不调用 OpenAI API，也不需要额外模型 API Key。Secure MCP Tunnel 本身需要由用户在 OpenAI Platform 单独配置 Runtime API Key 和 Tunnel ID。

### B. OpenCode Agent（尚未接入）

ChatCode 的可选适配器通过 `@opencode/sdk` 2.1.4 的 `OpenCode.create()`、`sessions.create()`、`sessions.get()` 和 `close()` 检查嵌入式服务及会话生命周期。它没有调用 `sessions.prompt()`，也没有集成到 MCP 工具或本机审批 UI，因此当前不能作为 Agent 执行模式使用。

实现 Agent 执行模式仍需配置 OpenCode 模型供应方，并把读写、Shell 和外部目录权限纳入本机审批。OpenCode Agent 不会调用 ChatGPT 网页订阅中的模型，也不能从当前 ChatGPT 对话获得推理上下文；当前 SDK 生命周期检查没有验证模型调用。

## 参考仓库结论

- OpenCode 本地源码标记版本 2.1.4。`@opencode/sdk` 的 Promise API 提供无监听器的内嵌服务和 `sessions` 客户端。ChatCode 通过 npm 发布包适配；会话生命周期已在隔离数据库中验证，Agent prompt 尚未验证。
- `codex-chatgpt-web` 里的 Native2/DSH 本地工具桥接包含产品特定的生命周期和权限路径，不能代表 ChatGPT 自定义 MCP 应用。ChatCode 采用标准 MCP stdio 与 OpenAI 官方 Secure MCP Tunnel，不接管 ChatGPT 浏览器或登录状态。
- WinCodex 展示了 loopback 服务、明确目录授权、Windows Credential Manager、日志脱敏和 Win32 文件句柄验证等安全边界。ChatCode 独立实现这些边界，不调用 WinCodex 服务或凭据。

## 数据流

```text
ChatGPT Web
  -> OpenAI Secure MCP Tunnel
  -> 本机 tunnel-client（stdio 子进程）
  -> ChatCode MCP 工具
  -> 本地授权状态与 Windows safe-fs
  -> 用户工作区
```

OpenAI Tunnel 仅解决传输，不替代工作区授权或 ChatGPT 写操作确认。MCP 写工具触发请求时，ChatCode 仍要求本机批准。正常关闭管理服务时，会尝试停止只属于 ChatCode Profile 的 runtime；WinCodex Tunnel 不受管理。

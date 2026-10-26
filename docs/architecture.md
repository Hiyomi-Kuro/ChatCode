# ChatCode 架构

## 组件

- `apps/server/admin.mjs`：只绑定 `127.0.0.1` 的本地管理页和 JSON API。目录授权及待执行变更审批只由此入口修改。
- `apps/server/ui/`：模块脚本初始化本机 CSRF 会话后才启用写操作；状态页分别显示 HTTP、MCP stdio、Tunnel 与 ChatGPT 网页端。
- `apps/server/core/tunnel.mjs`：调用官方 `tunnel-client` 检测、生成 Profile、读取 Tunnel metadata、运行 doctor 以及管理本机 runtime；Runtime API Key 由 Windows Credential Manager 提供。
- `scripts/credential-store.ps1` 与 `scripts/select-folder.ps1`：分别用于当前 Windows 用户的 Credential Manager 和用户明确操作的系统文件夹选择器。
- `apps/server/mcp.mjs`：MCP stdio 服务，由 OpenAI 官方 Secure MCP Tunnel 启动。MCP 参数不包含新增授权目录的能力。
- `apps/server/core/safe-fs.mjs` 与 `scripts/safe-fs.ps1`：严格解析根内相对路径；Windows 辅助程序使用句柄、最终路径和 reparse 属性检查执行文件操作。
- `apps/server/core/workspaces.mjs`：独立 workspace ID、暂停/恢复、只读、逐项审批、免逐项审批文件写入和敏感文件授权；`unattendedDev` 是额外的本机执行 profile，旧工作区不会自动获得执行范围。
- `apps/server/core/files.mjs`：带版本信息的元数据和按字节分页读取；文件类型不依赖解析器。
- `apps/server/core/uploads.mjs`：有序、可重试、可续传的分块上传；上传字节与小型元数据位于 `.tmp/uploads`，管理页区分传输与 SHA-256/原子发布阶段。
- `apps/server/core/changes.mjs`：按文件版本哈希暂存修改、生成统一 Diff；大块正文和恢复副本使用临时 blob，不写入大型 JSON 状态。
- `apps/server/core/file-ops.mjs`：文件树 manifest、copy/move/rename/大小写更名、软删除/恢复、多操作 durable journal、失败补偿和重启恢复；Windows 文件流仍由 Safe-FS 句柄验证。
- `apps/server/core/lsp.mjs`：按 workspace 启动有版本/哈希钉住的 TypeScript LSP；服务器只访问 `.tmp` 下的只读源码快照，工作区写入会失效并重建该快照。
- `apps/server/core/ripgrep.mjs`：发现并校验本机 `rg.exe`，在 Win32 安全文件清单约束下执行有界搜索，结果用临时磁盘 spool 和签名 cursor 分页。
- `apps/server/core/git.mjs`：本地 Git 运行时指纹、status/diff/log/branch、预览后 commit、CAS ref 更新和 ChatCode 所有权登记的专属 worktree。
- `apps/server/core/tasks.mjs`：固定项目脚本与命令模板、任务 ID、审批、状态轮询、输出分页和进程树取消；可选源码路径会在请求和启动时规范化及复核。
- `apps/server/core/agent-tasks.mjs`：保存宿主驱动 Agent 的目标、结构化依赖 DAG、输入版本、资源锁、有限重试、工件/输出、时间线与幂等键。ready 队列最多并行 3 步；状态文件用跨进程目录锁和原子替换。此模块不调用模型，也不授予工具权限。
- `apps/server/core/android.mjs` 与 `android-worker.mjs`：扫描 Android 工具链与 Gradle 项目，预览固定任务；手动 profile 保留管理页审批，匹配 `unattendedDev` 授权时异步排队并以独立持久 worker 执行。构建结果和日志写入项目 `.tmp`。
- `apps/server/core/skills.mjs`：只读发现 `CODEX_HOME/skills` 或 `%USERPROFILE%\\.codex\\skills`，过滤链接、脚本、敏感资源和超大文件，并为技能及资源提供 SHA-256/分页读取。
- `apps/server/core/custom-tools.mjs` 与 `tools/`：静态工具 manifest、Zod 参数 schema、动作 allowlist 和 MCP registry。android、mumu、project-summary 为首批包；不会动态加载工作区或远程 JS。
- `apps/server/core/mumu.mjs`：从实际 `mumu-cli info -v all` 重新验证本机选择实例的指纹，只向该实例执行受限状态、APK、前台 UI、截图和 Logcat 操作。
- `packages/opencode-adapter/adapter.mjs`：可选 OpenCode SDK 生命周期检查；不参与 ChatGPT 原生 MCP 的推理，也不改写上游代码。
- `data/`：授权、待审批更改、任务元数据和脱敏审计事件。
- `.tmp/`：可清理的缓存、日志、测试目录和短时运行状态。

## 推理和执行模式

### A. ChatGPT 原生 MCP（默认）

ChatGPT 网页版模型完成需求分析与编程决策。模型调用 ChatCode MCP 工具来列举、读取、搜索、暂存修改或请求固定项目检查。旧 `writable` 项目脚本仍逐项审批；`unattendedDev` 仅在本机管理页一次配置且精确匹配已保存范围后自动排队。服务器端在执行前重新校验工作区状态、路径、授权、脚本/项目输入哈希和执行器指纹。

该路径不调用 OpenAI API，也不需要额外模型 API Key。只读工作区拒绝写入；旧 `writable` 工作区继续要求本机逐项批准；`autoWritable` 只允许已授予范围的普通文件直接写入。执行授权另须通过本机管理页配置 `unattendedDev`，MCP 无权给自己授信。ChatGPT 平台的工具确认和 workspace 策略仍独立生效。Secure MCP Tunnel 本身需要由用户在 OpenAI Platform 单独配置 Runtime API Key 和 Tunnel ID。

`unattendedDev` 当前支持哈希绑定的已存在 npm script、固定 Node/Python/Go/Rust/.NET 检查模板、Android 固定 Gradle 任务、可选 Git 只读范围以及单独确认的 `gitWrite` 和 `fileLifecycle`；MuMu 操作还必须绑定一个本机发现并选中的实例。Shell 文本不可由模型指定。Git commit 通过隔离索引只提交预览中列出的文件，并对分支 ref 执行 compare-and-swap；worktree 使用生成路径，禁用 hooks，发现已配置外部 filters 时拒绝创建。Windows Sandbox/AppContainer/隔离用户执行后端尚未实现；固定模板中的脚本和 Gradle 仍以当前 Windows 用户运行。

### 文件生命周期、LSP 与代码搜索

`file-ops.mjs` 把源和目标限制在同一个 workspace，并要求当前 manifest SHA-256。软删除备份与 tombstone 存在 `DATA_DIR`；多文件提交通过 journal 和补偿构成可恢复事务，但跨卷 copy→delete 和多文件目录更新都不是物理原子操作。

LSP 将安全清单复制到隔离只读快照；`didOpen`、`didChange`、诊断和符号请求来自真实 TypeScript Language Server。任何文件生命周期、普通写入、上传、Git commit 或 worktree 切换会终止当前 workspace LSP 进程，下次请求重建快照。当前不提供 Java/Kotlin/Python LSP。

代码搜索使用本机已安装 `rg.exe`，不联网下载可执行文件。safe-fs 先枚举允许文件，ripgrep 的结果只保留这些路径；敏感文件、链接、内部目录和生成目录排除。游标引用磁盘分页缓存，缓存有大小/时间上限。LSP workspace symbols 是服务端的 TypeScript 索引，写入后通过停止 LSP 并重建快照失效；没有独立 AST、embedding 或自然语言语义索引。

### 宿主驱动的 Agent 检查点

Agent 检查点让 ChatGPT 在多轮文件操作、工具调用或 MCP 重连后恢复任务目标和已确认的步骤。ChatGPT 仍选择操作、读写文件、解释结果并决定下一步；服务不自行调用模型。检查点不是会话对话记录，也不是工作区授权或命令批准。Git 元数据是可选上下文：非 Git 目录和没有提交的新 Git 仓库都可以恢复；损坏的 Git 元数据只作为诊断报告，不应把检查点更新到一半。

### Android Gradle 构建

`get_android_environment` 只读扫描授权工作区内的 Android 项目、SDK、JDK、Wrapper、Gradle 版本、插件缓存和兼容性。`request_android_build` 只接受 `assembleDebug`、`testDebugUnitTest`、`lintDebug` 三项固定任务，并将 runner、精确参数、项目输入指纹、SDK/JDK、仓库配置和隔离缓存写入预览。`writable` profile 下管理页批准后启动；匹配的 `unattendedDev` scope 下请求立即返回 queued task ID，再异步重新检查授权、工作区、项目输入指纹、环境选择和 runner，随后启动脱离 MCP 生命周期的 worker。任务状态和分页日志可在 MCP 重连后查询或取消。

Android Gradle User Home、项目缓存、临时目录、HOME/APPDATA 和生成的构建树都位于 Android 项目的 `.tmp`。已缓存且校验的 Gradle 可直接运行；Wrapper URL 限制为 Gradle 官方发行站。构建任务运行后不自动发布任意文件。只有成功的 `assembleDebug` 可以通过固定 APK 路径检查；`get_android_build_artifacts` 验证 APK manifest、应用 ID、启动 Activity、min/target SDK、debug 签名及前后哈希，随后原子发布到同一项目的 `app-debug.apk`。此流程不签名发布版 APK。

Gradle 插件和项目构建脚本仍会以当前 Windows 用户身份运行，能访问该账户可访问的本机文件和网络；独立 worker、缓存隔离和允许任务列表不是 Windows 沙箱。Maven 仓库可能提供依赖，除仓库主机约束外，远端内容仍属于构建输入。详见 [`security.md`](security.md) 和 [`android-harness-design.md`](android-harness-design.md)。

### 按字节传输

`stat_file` 可返回 64 位十进制大小、修改时间、文件版本和可选的流式 SHA-256。`read_file_chunk` 按字节 offset 返回最多 262144 字节 Base64，并附 `next_offset`、EOF 和版本令牌。任意格式可逐块读取；`read_file` 是 UTF-8 预览便利工具，不能替代二进制或超大文件分块读取。

上传由 `begin_write`、`write_chunk`、`commit_write` 和 `abort_write` 组成。块顺序校验、最近一块重试幂等、SHA-256、权限中途撤销复核和 24 小时不活动过期由服务器负责。确认元数据落后于暂存文件时，Windows 辅助程序用 Int64 偏移安全截断未确认尾块，恢复不经过 JavaScript 浮点数。提交时 Windows 辅助程序以流方式把暂存内容复制到目标同目录临时文件，校验并原子发布；现有文件的旧版本经 SHA-256 复核后才替换。上传暂存使用磁盘文件，`data/changes.json` 只保留审批元数据和临时 blob ID。单次 MCP 调用是有界分块，完整文件大小不受应用层 1 MiB 限制；磁盘、文件系统、传输、内存和单次调用超时仍是实际边界。

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

OpenAI Tunnel 仅解决传输，不替代工作区授权或 ChatGPT 写操作确认。手动 profile 保留本机任务审批；`unattendedDev` 范围内符合条件的任务不产生待审批条目。正常关闭管理服务时，会尝试停止只属于 ChatCode Profile 的 runtime；WinCodex Tunnel 不受管理。

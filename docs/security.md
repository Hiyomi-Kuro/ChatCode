# ChatCode 安全与权限

## 本地服务

- 管理服务固定监听 IPv4 回环地址 `127.0.0.1`，不监听局域网或公网。
- 仅允许同源 `http://127.0.0.1:<port>` 的管理请求；状态修改还需要当前进程生成的 CSRF Token。不开启 CORS。
- 管理页先验证 `/api/session` 的来源、CSRF 值和 API 版本；该请求失败时会禁用写操作并显示重连入口。`/healthz` 只说明 HTTP 服务可响应，不表示 MCP 或 Tunnel 已连接。
- 回环服务不是 Windows 用户隔离边界。同一 Windows 登录会话中的进程仍可访问本地端口。不要在不可信 Windows 用户间共享当前账户。

## 工作区和路径

- 工作区只通过本机管理页创建。MCP 工具只接收 workspace ID 和根内相对路径。
- 每次写入调用重新检查授权是否存在、是否暂停、是否只读或可写。暂停、切换只读和撤销授权会拒绝后续工具调用。
- 拒绝 UNC、设备路径、备用数据流、路径穿越、Windows 设备保留名、尾随点/空格和重解析点。根路径和最终文件句柄都要验证在授权目录内。
- MCP 工具不能授权 ChatCode 的 `DATA_DIR` 或 `TMP_DIR` 本身，也不能从包含它们的父工作区访问这些状态路径。`.git`、`.hg`、`.svn`、`.tmp` 和 `node_modules` 即使被显式传入路径也会拒绝访问。
- OpenCode、codex-chatgpt-web、WinCodex 三个参考仓库及其祖先/后代路径永不允许授权。
- 新授权工作区不能与已有授权目录重叠；添加、路径选择、重复提交和保存仍由本机管理服务校验，前端验证不授予额外权限。
- 默认跳过 `.git`、`node_modules`、缓存、构建输出和 `.tmp`；敏感文件（例如 `.env*`、私钥、Token、Cookie 和凭据文件名）默认不可读写。用户可在本机管理页单独确认某个工作区的敏感文件访问；MCP 不能自行授予此权限。审计日志对敏感路径名使用 `[sensitive path]`，不记录文件正文或凭据。
- `read_file` 是有界 UTF-8 预览；`read_file_chunk` 按字节读取任意格式，单块最多 262144 字节，带 64 位十进制 offset、文件版本和 EOF。`stat_file` 返回 64 位大小字符串，可选择流式计算 SHA-256。没有整文件大小、行数或格式解析器门槛；单次请求和返回仍受 MCP 传输、内存和超时限制。
- `list_files` 支持 offset 和按名称游标分页；`search_files` / `search_text` 提供 continuation cursor，递归遍历不再固定 2000 个文件或 8 层上限。`search_text` 仍是 UTF-8 便利搜索，有单次扫描字节/结果预算，二进制或较大的文本应使用原始字节读取工具。正则搜索在受限工作线程中运行，超时终止。

## 工作区写入模式和文件修改

- `readOnly` 拒绝所有工作区写入。旧版 `writable` 保持“可写（逐项审批）”，不会隐式升权。`autoWritable` 只能通过本机管理页单独选择并确认；创建表单和工作区卡片都显示风险、状态、授予时间和审计记录。
- `writable` 模式保持 stage → 本机批准 → apply。`autoWritable` 模式的普通文件创建、覆盖、文本替换、补丁、目录创建和明确请求的文件更新不打开本机逐文件审批页。两种可写模式都重新检查 workspace 状态、授权路径和文件版本。只有普通文件工具获得此权限；固定项目脚本仍单独审批，MCP 不能修改工作区模式、增加授权根目录或触发目录删除。
- 小文件的 `write_file` 与文本便利编辑执行同样的路径、敏感文件和 SHA-256 校验。大文件使用 `begin_write` / `write_chunk` / `commit_write` / `abort_write`。上传以磁盘流暂存于 `.tmp/uploads`，64 位十进制 size/offset、顺序块、最近块重试、SHA-256、过期和中止都有明确状态。整个文件不放进一次 MCP 参数或巨型 Base64 JSON；单块最多 262144 字节，上传会话 24 小时无活动后过期。
- Windows 辅助程序通过已验证文件句柄读取/写入。中断恢复会以 Int64 精确截断暂存文件中的未确认尾块。提交把上传流复制到授权目录内的同目录临时文件，刷新并校验后，用 `ReplaceFileW` 原子替换旧文件；新建文件用不覆盖的原子移动。已有目标在替换时比较 SHA-256，发现用户并发修改则拒绝覆盖。路径、最终文件句柄、reparse point 和硬链接检查仍执行。
- 本机逐项审批正文和恢复备份保存在 `.tmp/uploads` 的普通文件中；`data/changes.json` 只含小型状态、哈希、Diff 和 blob ID。临时 blob 未加密，拥有当前 Windows 账户文件权限的进程可以读取。已审批文本/上传变更可在版本仍匹配时恢复；批量 `stage_unified_patch` 的自动模式逐文件写入，返回成功/失败项与恢复 ID，跨文件不是事务。新建文件或目录不自动撤销。
- 文件扩展名不是拒绝理由。PDF、Office、压缩包、图片、音视频、SQLite、可执行文件和无扩展名文件都作为原始字节读写；ChatCode 不会因此执行或解析它们。敏感文件保护与格式支持是两条独立规则。
- `fileLifecycle` 是独立的本机 unattendedDev scope。即使 workspace 是 autoWritable，没有该选项也不能 copy/move/rename/软删除。所有路径仍需 workspace 内相对路径；敏感路径、ChatCode 状态目录、reparse point、hardlink 与源/目标重叠均拒绝。软删除正文保存在持久恢复区 `DATA_DIR`，通用 `.tmp` 清理不触碰它。
- 多步骤文件动作先写 durable journal 并检查清单哈希；失败时仅补偿仍与已提交版本匹配的路径。无法安全补偿会返回 `partial_commit` 或 `recovery_required`，不覆盖并发文件。目录树和跨卷 copy→delete 是按项提交，不承诺多文件物理原子性。

## Git 写入与工具进程

- Git status/diff/log/branch 使用固定参数和本地已发现的 Git for Windows；Git 写入还要求本机在 `unattendedDev` 中同时勾选 `gitReadOnly` 和单独确认 `gitWrite`。MCP 参数不能提升授权。
- `git_preview_commit` 返回目标分支/HEAD、作者身份、单行 commit message、每个明确文件的 before/after SHA-256、文本 Diff 或二进制哈希。预览一小时有效，提交时重新校验 workspace、分支、目标文件版本和预览 SHA-256。
- commit 使用 ChatCode 自己的临时 index，从 HEAD 构建只含所列文件的 tree，再用 `update-ref <ref> <new> <old>` 比较交换发布。用户现有暂存区和其它未提交文件不加入。Git hooks 不运行；代码路径没有 push、force、reset、clean 或任意 Git 参数。作者默认取仓库本地配置，缺失时用 `ChatCode Local <chatcode@localhost>`，预览里显示最终作者。
- worktree 路径只由 ChatCode 在 `TMP_DIR/worktrees/<workspace-id>/<worktree-id>` 生成；记录所有权和创建 request ID。创建时覆盖 `core.hooksPath` 指向新建空目录，仓库配置包含外部 filter 时拒绝 checkout。移除要求 status（含 ignored/untracked）干净，不使用 force，保留该分支。
- Git 预览、提交或 worktree 元数据写入本机状态。提交树对象在 CAS 前可能形成无引用 Git 对象；CAS 失败不会覆盖已更新 ref，返回冲突并保留 journal。

## LSP、ripgrep 与 Agent DAG

- LSP 只处理 safe-fs 清单允许的文件副本。服务进程从固定 npm 依赖启动并校验版本/二进制 hash；项目不能通过 MCP 参数更改 LSP executable 或 cwd。工作区变化会停掉 server 并在下次请求基于新版本重建只读快照。
- `rg.exe` 必须是本机已发现的普通 GitHub/Codex 安装路径下可执行文件并核对版本和 SHA-256；ChatCode 不下载或运行用户工作区里的 rg。搜索子进程接收独立参数数组，没有 shell；文件选择先经过 safe-fs 白名单。
- Agent DAG 的依赖只控制宿主选择的 ready steps，不执行模型推理。每个 workspace 最多 3 个 step 可标为 `in_progress`；显式 file/process resource locks 防止并行冲突，依赖没完成时拒绝启动/完成。只有分类为 transient 的失败能按 maxRetries 重试；权限、路径、hash 和 compiler 类错误不会机械重试。
- `request_allowed_command` 可接收稳定 `request_id` 并复用持久任务回执；关联 DAG step 时需先将该 step 标记 `in_progress` 且依赖已完成。工具执行仍以当前 Windows 用户运行，计划状态和 subprocess 并不提供 OS 沙箱。

## 命令执行

- 不接受 Shell 字符串、命令数组、可执行文件路径或用户自定参数。
- 仅支持 `package.json` 中固定名称 `test`、`build`、`lint`、`typecheck`、`check` 的脚本；本机审批页显示项目脚本的实际内容和工作目录。
- 命令执行通过独立进程、授权根目录 `cwd`、超时、输出上限、脱敏环境变量和可取消任务管理进行。模型不可拼接命令字符串。
- 默认项目脚本逐任务审批。只有本机管理页另行启用匹配的 `unattendedDev` scope 后，已存在并哈希绑定的 npm 脚本或固定命令才会免逐项审批。
- 任意 Shell 文本不开放。固定命令不能改 executable、参数模板、cwd 或环境变量。执行进程仍使用当前 Windows 用户身份；ChatCode 未实现 Windows Sandbox、AppContainer 或隔离用户后端。cwd、worker 进程和独立缓存不是 OS 沙箱，不可信仓库不能授予无人值守权限。

### `unattendedDev` 执行范围

- 此 profile 需要工作区先由本机用户授予 `autoWritable`，然后从本机管理页明确选择和确认 npm script、固定命令、Android 项目/Gradle task、Git 只读权限、可选的 `gitWrite`/`fileLifecycle` 和 MuMu 实例。Git 写入要求同时有 Git 只读范围。既有 `autoWritable` 记录升级时仍没有执行授权。MCP 没有授权或扩展 profile 的工具。
- 授权记录绑定工作区根、npm `package.json`/script SHA-256、Android project-relative path/task、执行器指纹和所选 MuMu 的实例指纹。请求和启动时重新校验；暂停、撤销、切换模式、路径或哈希变化会拒绝未启动的任务。
- 任务先持久化为 `queued` 并立即返回 ID；后台启动后由 `get_task`/`get_task_output` 查看，`cancel_task` 终止进程树。未授权或越界请求明确失败，不留下待审批条目。旧 `writable` 逐项审批行为保持兼容。
- 撤销阻止新任务及尚未启动的任务；已经运行的进程需在任务页面单独取消。平台 ChatGPT 确认仍独立受账号和 workspace 策略控制。
- 审计事件记录授权/撤销、queued/start/failure/completion。`get_harness_status` 报告 `osIsolation: none`，不回显密钥。

### Android Gradle 构建

- Android 任务只接受 `assembleDebug`、`testDebugUnitTest` 和 `lintDebug`。请求会记录唯一 runner、固定参数、授权 workspace/project、SDK/JDK、Gradle 分发、仓库声明、输入文件哈希及隔离缓存路径；手动 profile 仍须管理页批准，匹配的 `unattendedDev` 项目/task 授权则异步排队。启动前再次比较 workspace 状态、输入指纹与 runner；授权或构建输入变化都会拒绝启动。
- Gradle Wrapper 只能指向 `services.gradle.org` 官方发行站；可用缓存的分发在启动前检查真实路径和文件类型。插件版本、Android SDK/JDK 兼容性与声明的仓库主机被扫描并加入诊断。下载依赖只写入项目内 `.tmp` 的 Gradle User Home，不复用用户全局 Gradle 初始化脚本或缓存。项目 `.tmp` 中的构建脚本和 Gradle 插件仍是执行代码。
- 构建在独立 Node worker 中运行，状态、runner PID、分页输出和取消信息持久化；MCP 服务重启后可接管状态，取消会尝试终止 worker 与子进程树。日志长度有限并执行基本敏感值过滤。独立进程、隔离缓存和固定任务不构成 Windows OS sandbox。
- Gradle 配置、插件和任务以当前 Windows 用户权限运行，可能读取或写入该用户能访问的工作区以外文件、启动子进程并访问网络。仅检查 Gradle 文件中可见仓库 URL 不能限制插件运行时网络或动态依赖来源。仅在信任项目代码和插件时批准构建；对需要真正隔离的仓库应使用 Windows Sandbox、虚拟机或容器等外部边界。
- 只有 `assembleDebug` 成功后才能调用 APK 发布工具。工具只从固定 debug 输出位置接收 APK，使用 Android `aapt` 检查包名、启动 Activity 和 SDK 字段，以 `apksigner` 验证签名，比较构建输入哈希并将 APK 原子复制到同一项目根的 `app-debug.apk`。这不是发布版签名；不接收任意来源/目标路径，不读取或使用用户 keystore。
- Android build `.tmp` 是项目级构建缓存和日志目录，不是全局临时区。清理前必须确认没有运行中的构建；最终 `app-debug.apk` 保留在项目根。

### Agent 检查点

Agent 检查点只保存目标、计划状态、有限摘要和任务关联；它不代表模型历史，不执行自主推理，也不授予 workspace、文件、命令或网络权限。跨进程状态更新使用锁目录和原子 JSON 替换；锁的陈旧恢复依据进程状态与时间，Git 诊断失败不能造成半提交检查点。

## 审计与临时文件

- `data/audit.jsonl` 不记录文件正文、密钥、Cookie、完整命令输出或请求认证头；常见敏感文件名以 `[sensitive path]` 代替。上传进度由每块 MCP 回执和本机“进行中的分块传输”列表显示；完整上传正在校验并原子发布时显示独立提交阶段，不提供误导性的取消按钮。
- `.tmp` 只放可再生成缓存、临时输出和测试夹具。`clean:tmp` 逐项检查允许清理的子目录，遇到 reparse point 只移除链接本身而不遍历目标，且服务运行时拒绝清理。
- `node_modules` 位于标准项目目录，可在服务停止后删除，再从 `package-lock.json` 重建。npm cache 固定在 `.tmp/cache/npm`。

## Secure MCP Tunnel

- Tunnel ID、客户端位置和 Profile 名保存在 `data/tunnel-settings.json`；Runtime API Key 单独保存在当前 Windows 用户的 Credential Manager。网页密码框保存后清空，不写入 URL、localStorage、Profile 或命令参数。
- 代理模式、URL 和变更时间保存在同一 ChatCode 配置内；默认 HTTP 地址为 `http://127.0.0.1:9910`。HTTP、系统代理和直连选择只影响官方 tunnel-client 子进程。HTTP 模式清除继承来的冲突代理值，并设置本机 `NO_PROXY`；没有把代理写入 Windows 全局设置。系统模式尊重当前服务继承到的环境变量，API 探测会检查 `NO_PROXY`，避免误走直连。直连模式明确移除所有已知 HTTP/SOCKS 代理变量。
- `tunnel-client` 使用 ChatCode 自己的 Profile/runtime home，并通过官方 `TUNNEL_CLIENT_STATE_DIR` 隔离本地 alias/admin 状态；不会扫描或复用其他客户端的 alias。Profile 只引用环境变量，不保存 Runtime API Key 或代理凭据。stdio MCP wrapper 启动后会清理 Tunnel Runtime Key 和所有代理变量。命令错误、运行事件和诊断会做长度限制与密钥脱敏。
- 状态分别报告本机 HTTP、MCP initialize/tools/list、代理 TCP/API、Tunnel 控制平面 poll 与 ChatGPT 工具发现。Tunnel `connected` 仅在本机 health 的 control-plane poll 成功且不处于 backoff 时成立。代理/网络暂不可达会保持本机管理页可访问，强制 HTTP 模式不作直连回退，并按 5 秒起步、最长 120 秒的指数退避重试。
- 启停脚本按 PID、进程创建时间、可执行文件、绝对脚本路径和项目/Profile 标识核对归属，并用同一项目范围的 Windows 命名互斥锁串行化脚本 Start/Stop。停止时先请求本地 CSRF 保护的优雅关闭，再等待 Tunnel runtime 与 stdio 子进程退出；超时后仅对重新核实的本项目进程定向停止。其他 Tunnel/WinCodex 和无关 `node.exe` 不在停止目标中。
- ChatGPT 是否已安装应用、是否发现 MCP 工具及网页调用结果需要用户在 ChatGPT 页面核实；管理页明确保留“需网页确认”状态。HTTP 401/403 的无 Key 探测仅证明 API 路径可达；HTTP 429 单独报告为限流，不当作连接成功或鉴权成功。

## 信任边界

仓库文件、网页文字、搜索结果、MCP 返回结果和项目脚本都视为不可信数据。模型提出的路径、Diff 或命令不能增加授权。写操作确认默认由 ChatGPT 和本机管理页两层分别控制；二者的角色不同。

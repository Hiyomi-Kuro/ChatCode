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
- 删除文件和破坏性 Git 操作没有 MCP 工具。

## 命令执行

- 不接受 Shell 字符串、命令数组、可执行文件路径或用户自定参数。
- `request_project_check` 仅支持 `package.json` 中固定名称 `test`、`build`、`lint`、`typecheck`、`check` 的脚本；`request_allowed_command` 仅支持 ChatCode 内置的固定 Node/Python/Go/Rust/.NET 测试/语法模板。模型不能提交 Shell 字符串、自定义可执行路径、参数数组、cwd 或环境变量。需要的文件路径只能是经安全路径检查的 workspace-root 相对路径。本机审批页显示完整命令、实际 executable 路径和工作目录。
- 命令执行通过独立进程、授权根目录 `cwd`、超时、输出上限、脱敏环境变量和可取消任务管理进行。模型不可拼接命令字符串。
- 项目脚本本身是代码，执行前必须先由本机用户确认。执行进程仍使用当前 Windows 用户身份；ChatCode 尚未把任意 npm 脚本限制到 Windows AppContainer 或独立虚拟机。不要批准不可信仓库里的脚本。高隔离运行时是后续安全增强项。

## 审计与临时文件

- `data/audit.jsonl` 不记录文件正文、密钥、Cookie、完整命令输出或请求认证头；常见敏感文件名以 `[sensitive path]` 代替。上传进度由每块 MCP 回执和本机“进行中的分块传输”列表显示；完整上传正在校验并原子发布时显示独立提交阶段，不提供误导性的取消按钮。
- `.tmp` 只放可再生成缓存、临时输出和测试夹具。`clean:tmp` 逐项检查允许清理的子目录，遇到 reparse point 只移除链接本身而不遍历目标，且服务运行时拒绝清理。
- `node_modules` 位于标准项目目录，可在服务停止后删除，再从 `package-lock.json` 重建。npm cache 固定在 `.tmp/cache/npm`。

## Agent task checkpoint

- `data/agent-tasks.json` 保存目标摘要、Host 提交的计划、最近操作摘要和状态，不包含完整 ChatGPT 对话或模型隐藏推理。每次 task 读取和更新都会重新验证关联 workspace 仍然有效。
- MCP 工具的任务摘要是记录，不是授权。仓库 README.md、AGENTS.md、Git commit message、工具输出和模型保存的步骤都不能改变服务端策略。
- task history 有长度与字段长度上限，并对常见 token/key 格式做脱敏；脱敏是纵深防御，不是通用秘密识别。不要将密钥放入任务目标或摘要。
- Agent task 状态与本地进程 job 状态分开保存。暂停、切换只读或移除工作区会请求终止相关后台项目脚本；脚本仍以当前 Windows 用户运行，不能把 `cwd` 当作系统级隔离。
- 管理进程与 MCP stdio worker 是不同 Node.js 进程。JSON 状态更新用进程间锁串行化；取消通过持久任务记录发送给 worker，再由 worker 终止 Windows 子进程树。任务记录保存执行 worker PID；管理进程启动时只把执行 worker 已退出的任务标为 `interrupted`，重复启动检查在任务恢复前完成。正常关闭时先请求取消并等待运行中的项目命令，再停止 ChatCode Tunnel。若执行 worker 崩溃，子进程恢复仍需检查实际进程与 Git 状态。

## Secure MCP Tunnel

- Tunnel ID、客户端位置和 Profile 名保存在 `data/tunnel-settings.json`；Runtime API Key 单独保存在当前 Windows 用户的 Credential Manager。网页密码框保存后清空，不写入 URL、localStorage、Profile 或命令参数。
- `tunnel-client` 只由 ChatCode 的绝对路径配置启动，使用 ChatCode 自己的 Profile/runtime home，并通过官方 `TUNNEL_CLIENT_STATE_DIR` 隔离本地 alias/admin 状态；不会扫描或复用其他客户端的 alias。启动前只检查 ChatCode 隔离目录，避免同一 Tunnel ID 重复启动；运行时密钥以环境变量引用读取 Credential Manager。命令错误、运行事件和诊断会做长度限制与密钥脱敏。
- 运行状态只代表本机 Tunnel Client 状态。ChatGPT 是否已安装应用、是否发现 MCP 工具及网页调用结果需要用户在 ChatGPT 页面核实；管理页明确保留“需网页确认”状态。
- 启停脚本先核对 runtime PID 与 `admin.mjs` 路径。停止时使用同源、CSRF 保护的关闭接口，并让服务停止自己管理的 Profile；只有正常关闭超时后才对已复核的 ChatCode PID 使用强制退出。
- 代理模式、地址、自动连接选择和更新时间保存在 `data/tunnel-settings.json`；自定义地址拒绝内嵌账号、密码、路径和查询参数。HTTP proxy 环境变量只在构造 ChatCode 子进程环境时设置或清除，不写入 Windows 用户/系统环境，也不传给本机 MCP stdio。强制代理故障时返回 `proxy_unavailable`，不自动直连。
- 代理配置变更仅由本机管理 API 的同源与 CSRF 校验后执行。重连前用 runtime alias 取得 PID，再通过系统进程信息核对实时可执行文件路径与启动时间；停止后等待原 PID 对应进程完全退出。身份不明或停止未确认时拒绝创建第二个实例。失败时恢复旧配置，并在安全条件允许时尝试恢复原连接。
- 代理测试只发送无密钥 HEAD 请求到 `api.openai.com/v1/models`；保留 TLS 证书验证，不记录响应正文、代理认证头、密钥或完整代理 URL。系统环境代理可能含凭据，UI 与诊断仅显示变量来源和脱敏后的主机/端口。Runtime API Key 仍仅从 Windows Credential Manager 读取并通过进程环境变量引用传给官方客户端。

## 信任边界

仓库文件、网页文字、搜索结果、MCP 返回结果和项目脚本都视为不可信数据。模型提出的路径、Diff 或命令不能增加授权。写操作确认默认由 ChatGPT 和本机管理页两层分别控制；二者的角色不同。

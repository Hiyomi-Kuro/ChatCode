# ChatCode 安全与权限

## 本地服务

- 管理服务固定监听 IPv4 回环地址 `127.0.0.1`，不监听局域网或公网。
- 仅允许同源 `http://127.0.0.1:<port>` 的管理请求；状态修改还需要当前进程生成的 CSRF Token。不开启 CORS。
- 管理页先验证 `/api/session` 的来源、CSRF 值和 API 版本；该请求失败时会禁用写操作并显示重连入口。`/healthz` 只说明 HTTP 服务可响应，不表示 MCP 或 Tunnel 已连接。
- 回环服务不是 Windows 用户隔离边界。同一 Windows 登录会话中的进程仍可访问本地端口。不要在不可信 Windows 用户间共享当前账户。

## 工作区和路径

- 工作区只通过本机管理页创建。MCP 工具只接收 workspace ID 和根内相对路径。
- 每次文件访问重新检查授权是否有效、是否暂停、是否只读。
- 拒绝 UNC、设备路径、备用数据流、路径穿越、Windows 设备保留名、尾随点/空格和重解析点。根路径和最终文件句柄都要验证在授权目录内。
- MCP 工具不能授权 ChatCode 的 `DATA_DIR` 或 `TMP_DIR` 本身，也不能从包含它们的父工作区访问这些状态路径。`.git`、`.hg`、`.svn`、`.tmp` 和 `node_modules` 即使被显式传入路径也会拒绝访问。
- OpenCode、codex-chatgpt-web、WinCodex 三个参考仓库及其祖先/后代路径永不允许授权。
- 新授权工作区不能与已有授权目录重叠；添加、路径选择、重复提交和保存仍由本机管理服务校验，前端验证不授予额外权限。
- 默认跳过 `.git`、`node_modules`、缓存、构建输出、`.tmp` 和常见密钥文件；拒绝读取 `.env*`、私钥、Token、Cookie 和凭据文件名。
- 文本读取和搜索有单文件、总扫描字节、深度、结果数及返回字符上限。正则搜索在受限工作线程中运行，超时终止。

## 文件修改

- MCP 先把候选正文保存为待审批项并返回 Diff 与原文件 SHA-256。
- 本机管理页显示 Diff。用户确认后才设置服务端 `approved` 状态。
- 应用时重新检查 workspace 可写、未暂停、同一目录授权仍有效、原文件哈希未变化。新增文件采用 `CREATE_NEW` 语义；已有文件先通过已验证句柄核验 SHA-256，在同目录写入并刷新临时文件，再次校验目标哈希后用 Windows `ReplaceFileW` 原子替换。因此读者不会看到半写入文件，替换失败时原文件保留。哈希复核与按路径执行替换不是单个内核操作；若其他程序在最后一次复核后同时修改目标，极端竞态仍可能覆盖其更新。
- 变更原文和提议内容以 Base64 保存在被 Git 忽略的 `data/changes.json`，用于审批、重启恢复和撤销；这不是加密存储，拥有本机账户文件权限的程序可以读取。审计日志不写文件正文。操作日志只记录操作类型、工作区 ID、相对路径、哈希、时间和结果。
- 本机管理页可恢复已应用或失败的文本修改。只有当前文件 SHA-256 仍匹配原版或 ChatCode 提议版时才恢复原文；若用户期间有其他改动，恢复会拒绝覆盖。新建文件和目录不能自动撤销。批次中的文件逐个审批和应用，不是事务。
- 删除文件和破坏性 Git 操作没有 MCP 工具。

## 命令执行

- 不接受 Shell 字符串、命令数组、可执行文件路径或用户自定参数。
- 仅支持 `package.json` 中固定名称 `test`、`build`、`lint`、`typecheck`、`check` 的脚本；本机审批页显示项目脚本的实际内容和工作目录。
- 命令执行通过独立进程、授权根目录 `cwd`、超时、输出上限、脱敏环境变量和可取消任务管理进行。模型不可拼接命令字符串。
- 项目脚本本身是代码，执行前必须先由本机用户确认。执行进程仍使用当前 Windows 用户身份；ChatCode 尚未把任意 npm 脚本限制到 Windows AppContainer 或独立虚拟机。不要批准不可信仓库里的脚本。高隔离运行时是后续安全增强项。

## 审计与临时文件

- `data/audit.jsonl` 不记录文件正文、密钥、Cookie、完整命令输出或请求认证头。
- `.tmp` 只放可再生成缓存、临时输出和测试夹具。`clean:tmp` 逐项检查允许清理的子目录，遇到 reparse point 只移除链接本身而不遍历目标，且服务运行时拒绝清理。
- `node_modules` 位于标准项目目录，可在服务停止后删除，再从 `package-lock.json` 重建。npm cache 固定在 `.tmp/cache/npm`。

## Secure MCP Tunnel

- Tunnel ID、客户端位置和 Profile 名保存在 `data/tunnel-settings.json`；Runtime API Key 单独保存在当前 Windows 用户的 Credential Manager。网页密码框保存后清空，不写入 URL、localStorage、Profile 或命令参数。
- `tunnel-client` 只由 ChatCode 的绝对路径配置启动，使用 ChatCode 自己的 Profile/runtime home，并通过官方 `TUNNEL_CLIENT_STATE_DIR` 隔离本地 alias/admin 状态；不会扫描或复用其他客户端的 alias。启动前只检查 ChatCode 隔离目录，避免同一 Tunnel ID 重复启动；运行时密钥以环境变量引用读取 Credential Manager。命令错误、运行事件和诊断会做长度限制与密钥脱敏。
- 运行状态只代表本机 Tunnel Client 状态。ChatGPT 是否已安装应用、是否发现 MCP 工具及网页调用结果需要用户在 ChatGPT 页面核实；管理页明确保留“需网页确认”状态。
- 启停脚本先核对 runtime PID 与 `admin.mjs` 路径。停止时使用同源、CSRF 保护的关闭接口，并让服务停止自己管理的 Profile；只有正常关闭超时后才对已复核的 ChatCode PID 使用强制退出。

## 信任边界

仓库文件、网页文字、搜索结果、MCP 返回结果和项目脚本都视为不可信数据。模型提出的路径、Diff 或命令不能增加授权。写操作确认默认由 ChatGPT 和本机管理页两层分别控制；二者的角色不同。

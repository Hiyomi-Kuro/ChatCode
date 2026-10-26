# 第八阶段交付报告

日期：2026-10-25（Asia/Singapore）

本报告总结无人值守 Harness、Skills、自定义工具包、MuMu 接入与真实 Calculator 验收。代码和测试位于 ChatCode 仓库；端到端 Android 构建仅使用隔离测试副本，没有改动 `D:\Download\ChatCode\Calculator`。

## 实施内容

- 增加工作区级 `unattendedDev` 执行授权。它由本机管理 API 配置，可限制 npm 脚本、固定 Gradle task、Git 只读操作和选定 MuMu 实例；任务异步持久化，执行时重查授权、范围、工作区和执行器指纹，保留审计、撤销和取消入口。既有 `readOnly`、`writable` 与 `autoWritable` 语义仍可用。
- 增加只读 Codex Skills provider，扫描用户 Skills 根并提供列表、内容、资源读取和刷新；不执行 Skill 内脚本。
- 增加静态自定义工具目录和 manifest，包含 `android`、`mumu` 与只读 `project-summary` 示例。原有 MCP 名称通过兼容 fixture 保持。
- 增强 Android runner 与 MuMu 工具：实例发现、设备绑定、安装/启动/停止、日志、截图、UI hierarchy、可见性和崩溃诊断。对 CLI 报成功但未创建 Activity 的情况，先查运行状态，再以同一个已选 MuMu 实例启动经 APK 校验的 launcher。
- 更新管理页、README、架构/安全/MCP/Android/Skills/MuMu 文档及验收证据。

## 工具发现

基线是 42 项 MCP 工具。本轮 Edge headless 浏览器实际报告 `tools/list` 为 63 项；集成测试逐项断言原 42 个名称仍存在。新增的 21 项覆盖无人值守执行、Skills、工具包目录/摘要和 Android/MuMu 工作流。真实 ChatGPT 网页端与 Secure MCP Tunnel 未连接，本机列表结果不能替代平台侧发现。

原 42 个工具名完整清单见 [`legacy-mcp-tools.json`](../tests/legacy-mcp-tools.json)。本轮新增的 21 个工具名为：`list_skills`、`get_skill`、`read_skill_resource`、`refresh_skills`、`list_custom_tools`、`get_custom_tool_manifest`、`get_custom_tool_status`、`project_summary`、`list_mumu_instances`、`get_mumu_status`、`start_mumu_if_needed`、`get_android_devices`、`install_debug_apk`、`launch_android_app`、`stop_test_app`、`get_logcat`、`capture_screenshot`、`dump_ui_hierarchy`、`run_android_instrumentation_or_uiautomator`、`collect_crash_diagnostics`、`validate_android_ui`。

主要变更文件：

- 服务端与 UI：[`admin.mjs`](../apps/server/admin.mjs)、[`mcp.mjs`](../apps/server/mcp.mjs)、[`android.mjs`](../apps/server/core/android.mjs)、[`tasks.mjs`](../apps/server/core/tasks.mjs)、[`workspaces.mjs`](../apps/server/core/workspaces.mjs)、[`custom-tools.mjs`](../apps/server/core/custom-tools.mjs)、[`skills.mjs`](../apps/server/core/skills.mjs)、[`mumu.mjs`](../apps/server/core/mumu.mjs)、[`admin.js`](../apps/server/ui/admin.js)、[`index.html`](../apps/server/ui/index.html)。
- 工具包：[`android/manifest.json`](../tools/android/manifest.json)、[`mumu/manifest.json`](../tools/mumu/manifest.json)、[`project-summary/manifest.json`](../tools/project-summary/manifest.json)、[`tools/README.md`](../tools/README.md)。
- 自动化：[`mcp.integration.test.mjs`](../tests/mcp.integration.test.mjs)、[`unattended-dev.integration.test.mjs`](../tests/unattended-dev.integration.test.mjs)、[`skills-provider.test.mjs`](../tests/skills-provider.test.mjs)、[`custom-tools.unit.test.mjs`](../tests/custom-tools.unit.test.mjs)、[`mumu-calculator.acceptance.mjs`](../tests/mumu-calculator.acceptance.mjs)、[`windows-ocr.ps1`](../tests/windows-ocr.ps1)。
- 文档和配置：[`README.md`](../README.md)、[`architecture.md`](architecture.md)、[`security.md`](security.md)、[`chatgpt-mcp.md`](chatgpt-mcp.md)、[`validation.md`](validation.md)、[`android-harness-design.md`](android-harness-design.md)、[`unattended-harness.md`](unattended-harness.md)、[`skills-and-custom-tools.md`](skills-and-custom-tools.md)、[`mumu-acceptance.md`](mumu-acceptance.md)、[`package.json`](../package.json)。

工具实现入口：[`mcp.mjs`](../apps/server/mcp.mjs)、[`custom-tools.mjs`](../apps/server/core/custom-tools.mjs)、[`skills.mjs`](../apps/server/core/skills.mjs)、[`mumu.mjs`](../apps/server/core/mumu.mjs)。包目录见 [`tools/README.md`](../tools/README.md)。

## 实际 MuMu 验收

- MuMu CLI 6.6.4.0；发现并选定 index `0`，`Kaori Izuki's vivo X100`，Android 12.0，ADB `127.0.0.1:16384`。目标应用处于逻辑 display 24。
- 隔离 APK package `com.example.chatcode.calculator.acceptance.r80791c2e64aa`，22,488 bytes，SHA-256 `0b7b1cc133e86d3b86236115fb1a6d2bff9ea3c39af3365ad9c797dd072b354e`。
- 通过构建、JUnit 与 Lint；三轮冷启动和三轮结束检查均验证进程、Activity、窗口与 Surface。9 项 UI 操作/输出通过：`12.5+2=14.5`、`19.5−4=15.5`、`7×8.5=59.5`、`84÷2.5=33.6`、清除、除零 Error、Error 后 `42.5`、退格后 `16.5`、AC 清屏。
- 截图 OCR 读取数字显示；清屏通过与同一 app 的零显示截图哈希比较。`dump_ui_hierarchy` 返回无效/空 XML，故不计作层级检查通过。过滤后的 app Logcat 为 0 行，crash diagnostics 为 false。
- 原 Calculator 源树验收前后 SHA-256 均为 `95d5b8e3c08d57aee9bfaed3144b468009097b58515cf2a89b4a338215fb8439`；原 APK 验收前后 SHA-256 均为 `a92b549e1d6d2f79b5ac8973d136d5173c684d0360472ab184cbe720652024d2`。
- 完整设备和任务状态：[acceptance-evidence.json](../.tmp/tests/mumu-calculator-2026-10-24T17-23-26-762Z-1fd92246-f553-4688-8170-593a6219f88f/acceptance-evidence.json)。代表性截图：[14.5 calculation](../.tmp/tests/ws-e9bab825/workspace%20with%20spaces/Calculator/.tmp/mumu/screen-2026-10-24T17-46-38-595Z-9a8e332c-cadb-4e3b-8fd7-0a7aa5136554.png)。

## 自动化回归

| 命令 | 结果 |
|---|---:|
| `npm test` | 8/8 通过 |
| `npm run test:browser` | 18 项浏览器断言通过；MCP tools/list 为 63 项 |
| `npm run test:harness` | 最终 8/8 通过；第一次运行有一次未复现的 MCP HTTP 400，隔离重跑通过后整套重跑通过 |
| `npm run test:agent-e2e` | 1/1 通过 |
| MuMu Calculator acceptance | 9/9 检查通过 |

最终 manifest namespace 唯一性修正后，`node --test tests/custom-tools.unit.test.mjs` 与 `node --test tests/mcp.integration.test.mjs` 再次通过，分别 1/1；MCP 集成用例再次验证旧工具名称仍能从实际 `tools/list` 发现。

## 尚未实现或未验证

- 文件/目录 copy、move、rename、可恢复删除与多操作事务尚未实现。当前已有有界列表/读取、搜索、原始字节分块写入、哈希条件文件修改、目录创建和既有变更恢复。
- 受托管生命周期的 LSP server、definition/references/hover/document/workspace symbols 与跨文件诊断 API 尚未实现。
- `search_text` 仍为便利扫描：每文件上限 1 MiB、每次最多扫描 16 MiB；ripgrep 优先搜索与增量语义索引尚未实现。
- Git 仍以既有只读 status/diff/context 为主；commit、worktree 等受控写操作未实现。Agent 有持久任务/检查点与恢复，但完整依赖 DAG、分类重试和步骤策略未实现。
- 没有 Windows Sandbox/AppContainer 等 OS 隔离。限定的 npm/Gradle 命令仍以运行 ChatCode 的当前 Windows 用户身份执行；这不是沙箱。
- 本地 MCP tools/list 与 headless 浏览器已验证；Secure MCP Tunnel、ChatGPT 网页端工具确认和平台侧确认行为未验证。
- MuMu 的 hierarchy dump 无有效 XML。截图 OCR 验证了显示结果，但不能代替语义 UI tree。

逐项测试矩阵、阶段记录与更详细边界见 [`validation.md`](validation.md)、[`mumu-acceptance.md`](mumu-acceptance.md)、[`unattended-harness.md`](unattended-harness.md) 和 [`skills-and-custom-tools.md`](skills-and-custom-tools.md)。

# Android 构建与 Agent 恢复验证

日期：2026-10-24

## ChatCode 自动化回归

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm test` | 通过，4/4，0 失败 | MCP stdio 集成、Agent/固定命令跨进程 E2E、Gradle 诊断单元测试、Android worker 恢复测试；总计约 182.7 秒 |
| `npm run test:browser` | 通过，18 项断言 | Edge headless 实际操作管理页和 stdio MCP；确认服务报告 42 个注册工具，并区分 Tunnel 在线与 ChatGPT 网页待确认状态 |
| `npm run test:harness` | 通过，4/4，0 失败 | 指定的 MCP integration、Agent command E2E、Android harness unit、Android task recovery；总计约 157.2 秒 |
| `npm run test:agent-e2e` | 通过，1/1，0 失败 | 真实隔离 Admin + MCP 多进程；覆盖非 Git resume 原子性、空/空值/省略路径归一化、TAP、拒绝未批准命令、输出分页、取消和跨进程 checkpoint；约 87.9 秒 |
| `node --check`（修改的 server/MCP JS） | 通过 | Android/Agent/task/Git/state/MCP/admin 模块均无语法错误 |
| `git diff --check` | 通过 | 无空白错误 |

`npm test` 和 `test:harness` 都包含耗时较长的真实 MCP integration。测试期间新增加的 Agent E2E、诊断解析和 detached worker 恢复用例也均通过。

## Calculator 项目

项目文件和目录通过连接的 ChatCode workspace `4401d067-6bbf-4f15-b7e0-1edeffa9d6ba` 创建并读取；项目共 18 个输入文件。项目为 Java/原生 Android Views，application ID 为 `com.example.calculator`，minSdk 23、targetSdk 35、compileSdk 36、AGP 8.13.2、Gradle 8.13 和 Java 17。Manifest 不声明 permissions。计算引擎及 JUnit 测试覆盖十进制精度、四则运算左结合、重复等号、清空、删除、正负号和除零恢复。

Gradle wrapper JAR 从只读 Android 参考项目复制后经 ChatCode `stat_file` 复核；SHA-256 为 `81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f`，与来源文件一致。该引用项目只读，未被修改。

## ChatCode connector 与工具链

当前会话 `ALL_TOOLS` 和 ChatCode `get_tool_catalog` 集合精确一致：42 个工具，schema `2026-10-24.android.1`，含 4 个 Android 工具。`get_android_environment` 检查确认 SDK 36、build-tools 36.0.0、SDK license 已接受、Gradle 8.13、JDK 17。项目缓存未包含 AGP 8.13.2；固定 runner 使用 Calculator 项目隔离的 `.tmp` Gradle user home 与 project cache，依赖仓库限定为审批预览中的 Google、Maven Central 与 Gradle Plugin Portal。

## 真实 Calculator Android 构建

- 本机批准任务：`89779a77-8cd4-44c0-a577-76e57baf96b4`，批准时间 `2026-10-24T11:04:02.463Z`。仅通过 ChatCode Android runner 运行固定任务 `:app:assembleDebug`；MCP 启动调用超时后，用持久化任务查询确认 detached job 已启动，未重试或重复构建。
- 构建结果：成功，exit code 0；34 项 Gradle task 执行，耗时 1 分 51 秒；Gradle 8.13、AGP 8.13.2、JDK 17、Android SDK 36。输出和缓存保留于 `Calculator/.tmp`。
- 构建日志有一项 Android SDK XML 版本兼容警告（工具最多识别 XML v3，但本机 SDK 含 v4），以及 `MainActivity` 使用 deprecated API 的编译提示；构建仍成功。
- Artifact 工具验证 APK 后原子发布到 `D:\Download\ChatCode\Calculator\app-debug.apk`。大小 19,534 字节，SHA-256 `a92b549e1d6d2f79b5ac8973d136d5173c684d0360472ab184cbe720652024d2`。
- APK Manifest 检查通过：package `com.example.calculator`、version `1.0`、launcher `com.example.calculator.MainActivity`、minSdk 23、targetSdk 35。`apksigner` 验证通过，v1 与 v2 签名均有效。随后由 ChatCode `stat_file(include_sha256=true)` 独立回读，大小和 SHA-256 与 Artifact 结果一致。

## 尚待完成

Android `testDebugUnitTest` 已提交本机审批，任务 ID `ef9c8efd-0095-4e87-9d6e-bcc0bb0bc1b1`，当前等待批准，尚未执行。批准后运行并记录 JUnit 结果，再完成最终报告。未安装到设备，未构建 release APK/AAB。
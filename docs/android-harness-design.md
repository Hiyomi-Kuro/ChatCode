# Android 构建任务设计

## 目标与边界

Android 构建是由 ChatGPT 宿主驱动的本地工具流程。模型选择项目和固定任务；ChatCode 检查授权、解析工具链、保存精确预览并等待本机用户审批；批准后，独立 worker 执行 Gradle 并将受限日志写入项目 `.tmp`。MCP 不调用另一个模型，也不接受任意 shell、Gradle 参数、runner 路径、环境变量或发布路径。

目前允许的 Gradle task 为 `assembleDebug`、`testDebugUnitTest` 和 `lintDebug`。APK 发布只适用于成功的 `assembleDebug`，目标固定为同一 Android 项目根的 `app-debug.apk`。构建需要工作区处于可写和未暂停状态，因为 runner 会在项目内创建 `.tmp` 缓存、临时文件、日志和构建输出；读取环境信息不改写全局设置。

## 调用流程

1. `get_android_environment(workspace_id, project_path)` 在已授权工作区内定位项目，检查 SDK、platform/build-tools、license、JDK、Gradle Wrapper 或可验证的缓存发行版，并解析 AGP/Kotlin 版本与最低 Gradle 兼容性。工具返回诊断，不下载工具或修改机器级配置。
2. `request_android_build` 验证任务 allowlist 和完整项目结构，扫描 Gradle 配置、仓库主机、Wrapper URL、现有构建输出及缓存，构造精确 runner 和项目输入指纹。请求本身不启动构建。
3. 本机管理页展示项目路径、Gradle task、可执行文件、参数、工作目录、JDK/SDK、发行版来源、构建缓存位置、输入哈希和已识别风险。只有本机用户明确批准后才可继续。
4. `run_approved_android_build` 复核一次性批准、workspace、项目输入指纹、环境选择和 runner 参数。它启动脱离 MCP 生命周期的 `android-worker.mjs`；worker 再次检查已批准任务并调用固定 Gradle launcher。一个 Android 项目同一时间最多运行一个受管 build。
5. `get_task` 与 `get_task_output` 可在构建运行或 MCP 重连后读取状态和分页日志。`cancel_task` 会结束持久 worker 和子进程树；服务启动恢复时保留仍存活 worker，并把已经消失的孤立任务标记为中断。
6. 成功的 `assembleDebug` 通过 `get_android_build_artifacts` 检查固定输出 APK。工具要求 Gradle 成功且任务匹配；使用 Android `aapt` 检查 package、launcher Activity、minSdk 和 targetSdk，使用 `apksigner verify` 检查 APK 签名，检查输入指纹和 APK 哈希，然后原子发布。再次读取时会校验已发布文件的大小和 SHA-256。

## 项目与工具链检查

工具链扫描选择 JDK 17，并记录 Android SDK 路径、已安装的平台、Build Tools、许可证和必要工具。Gradle Wrapper 版本从 `gradle-wrapper.properties` 读取，只接受 `https://services.gradle.org/distributions/gradle-...-(bin|all).zip`。若使用已解压缓存，要求 launcher、发行版元数据、实际版本与文件路径验证通过；需要 Wrapper 时也只运行项目的标准 Wrapper JAR 和属性。

扫描已声明的 Google、Maven Central、Gradle Plugin Portal 等仓库地址及其允许主机；未知仓库会在请求诊断和审批预览里明确显示，要求修复后再申请。插件版本、Gradle、JDK、compileSdk 和 SDK 许可证必须满足检查。动态版本、脚本注入和 Gradle 插件行为不可能只靠静态解析完全预测，因此预览会保留这一执行风险。

Gradle User Home、项目缓存、HOME/APPDATA、TEMP、Android 用户目录、日志和 `buildDirectory` 全部重定向到项目 `.tmp`。不会将用户全局 init script、`gradle.properties`、凭据或代理设置复制进隔离 home。npm/Node 固定命令使用另一套受限模板，不会被 Android 项目路径覆盖。

## 持久化与失败诊断

Agent task 检查点、任务审批和执行状态分别保存；状态变更在进程间用锁目录串行，并通过同目录临时文件原子替换 JSON。Agent resume 先读取 workspace/Git 上下文，完成全部可能失败的检查后再更新 revision，防止返回上下文失败却悄悄改变任务状态。不存在 Git 仓库、空 Git 仓库和损坏 Git 元数据会有不同诊断，Git 不是 Agent 恢复的前置条件。

命令任务把 `node_test` 的未指定路径、显式 `null` 与空字符串规范成同一个“省略路径”状态；持久化后精确复核重新派生的固定 executable/args，而不是相信旧 JSON 中保存的命令。源码路径只做根内相对路径规范化，路径穿越和不匹配模板的路径均拒绝。测试输出按页读取并限制在 128 KiB 总量。

Gradle 诊断对 Groovy/Kotlin DSL、AGP/Gradle/JDK/SDK 兼容、插件仓库、Java/Kotlin 编译、资源、依赖解析和 dex 等常见失败归类并返回位置线索。它们用于宿主模型理解日志，不会自动改项目或自动重跑。

## 安全限制

审批和精确 runner 限制了 ChatCode MCP 能请求的 task，但没有给 Gradle 代码提供操作系统沙箱。Gradle settings、插件和项目任务以当前 Windows 用户权限运行，可能启动子进程、访问其可读写的其他文件并访问网络。独立 worker、隔离缓存和仓库 URL 检查都不能替代 Windows Sandbox、虚拟机或容器。只有信任项目、插件和下载源时才批准构建。

仅发布 debug APK，不执行 release signing、不读 keystore，也不从任意路径复制 APK。`.tmp` 构建树可能较大；删除前应确认没有正在运行的 build，并保留根目录最终 APK。

## 参考实现与资料

- OpenCode 将工具权限分为 allow/ask/deny 并支持不同工具、路径和会话的规则。ChatCode 参考了“执行前明确 ask”的边界，但将 Android 命令收窄为固定 task，并由独立本机页面批准：[OpenCode permissions](https://opencode.ai/docs/agents/)。
- Aider 的 lint/test 流程将测试非零退出及其输出交还给模型，由模型判断修复和重跑。ChatCode 提供持久任务、状态和分页输出，但不会在服务端自动调用模型或自行修复：[Aider lint/test](https://aider.chat/docs/usage/lint-test.html)。
- OpenHands 将命令放在可选 Docker runtime 中形成更强的执行隔离。ChatCode 当前只把 worker 与 Gradle 缓存分开，没有等价的 OS sandbox：[OpenHands runtime architecture](https://github.com/OpenHands/docs/blob/main/openhands/usage/architecture/runtime.mdx)。
- Android 官方命令行构建说明、AGP 与 Gradle 兼容表、JDK 选择和 Gradle 用户目录作为工具链约束依据：[Android command-line builds](https://developer.android.com/build/building-cmdline)、[AGP compatibility](https://developer.android.com/build/releases/about-agp)、[Android JDK selection](https://developer.android.com/build/jdks)、[Gradle directory layout](https://docs.gradle.org/current/userguide/directory_layout.html)。

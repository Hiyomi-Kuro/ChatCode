# MuMu Android tools and Calculator acceptance

ChatCode uses the installed MuMu CLI and its ADB bridge. It does not substitute Android Studio Emulator.

## Device boundary

`list_mumu_instances` runs the local CLI discovery and reports its version, binary hash, and current instance metadata. The workspace's local `unattendedDev` grant can select one returned index. Each later device operation re-discovers the VM and compares its index, name, Android version, ADB host, and port. If the VM is missing or its identity changes, the tool fails closed. It does not create, delete, clone, reset, or wipe VM data.

The device tools include `get_mumu_status`, `start_mumu_if_needed`, `get_android_devices`, `install_debug_apk`, `launch_android_app`, `stop_test_app`, `get_logcat`, `capture_screenshot`, `dump_ui_hierarchy`, `run_android_instrumentation_or_uiautomator`, `collect_crash_diagnostics`, and `validate_android_ui`. ADB is addressed only through the selected MuMu CLI instance. There is no free-form shell field. UI automation accepts bounded taps, text, and a small key allowlist. The harness detects the target Activity and window on its Android logical display, routes input to that display, and maps it to MuMu's physical display ID for screenshots. MuMu versions that return success from `app launch` without starting the app receive a bounded `am start -W` fallback for the launcher component recorded from the validated APK. Screenshot and hierarchy capture require the target package to have a live process and visible Activity/window or Surface on its display. Logs are filtered to the built package/current PID and redacted before return.

`validate_android_ui` samples the resumed Activity, process ID, window visibility, and SurfaceFlinger layers for three to five rounds. Process existence by itself does not pass. App install requires an `assembleDebug` task that completed successfully in the same workspace, was published by ChatCode, and still matches its recorded SHA-256 and APK package/launcher metadata.

## Reproduce the Calculator run

`npm run test:mumu` creates a fresh workspace and isolated ChatCode data under `.tmp/tests`, copies the Calculator sources while omitting `.git`, `.tmp`, generated build directories, artifacts, and APK files, and records source/APK hashes before and after. It uses the MCP and local CSRF-protected management API to set a test-only `unattendedDev` scope. It tests a broken Node module, fixes it through a hash-guarded MCP write, and reruns `npm test`; then it runs `assembleDebug`, `testDebugUnitTest`, and `lintDebug`, validates/publishes the APK, and drives the selected MuMu instance through a cold launch and calculator UI checks. The copy receives a unique package ID per run so its debug signing key does not conflict with previously installed builds or the original Calculator package. UI checks map keypad taps from screenshot dimensions and verify the calculator display with Windows OCR over a crop that excludes the Android status bar and keypad; zero is also checked against the pixel hash of the same app after pressing AC.

The test selects the sole running instance discovered for this run. If more than one instance is running, it aborts before device actions to avoid choosing a VM in use. If there is no running VM and multiple existing VMs, it also aborts rather than guessing. The copied app may be installed on the chosen MuMu VM and the test app may be stopped; no app data wipe or VM reset is performed. Leave other running instances untouched.

Evidence is stored under the run's `.tmp/tests/mumu-calculator-*/acceptance-evidence.json` plus the copied Calculator project's `.tmp/logs` and `.tmp/mumu` (PNG screenshots and XML hierarchy). The original `D:\Download\ChatCode\Calculator` project and its APKs are read-only inputs to the acceptance script.

## Acceptance result

The latest real run's pass/fail status, exact VM identity, task IDs, Android toolchain versions, APK hash, UI visibility rounds, calculation assertions, screenshots, hierarchy, filtered Logcat, crash diagnostics, and source/APK before/after hash comparison are recorded in the machine-readable evidence file referenced from [`validation.md`](validation.md). Unit tests and static mocks are not substitutes for this live device run. A failed or interrupted run must be reported as such; no screenshot or device pass may be inferred from a build-only result.

## Known limitations

MuMu's `uiautomator dump` may return `null root node returned by UiTestAutomationBridge` for an app on its virtual display. The backend returns this as an explicit hierarchy error and verifies that any successful hierarchy contains the target package; it never accepts a launcher hierarchy as the Calculator tree. Screenshot OCR provides display evidence for the acceptance run but is not a semantic UI hierarchy. Record hierarchy availability separately from calculation checks.

This implementation does not install the MuMu application itself and does not update the user's Codex Skill. Device operation requires a local admin grant bound to one discovered instance. Android build scripts and project code run with the current Windows user's OS permissions; ChatCode does not currently provide Windows Sandbox or an equivalent isolated execution backend.

## Phase 9 hierarchy recheck

The first check on 2026-10-25 found `com.meizu.media.music` on logical display 2 and was correctly marked `BLOCKED`; see `.tmp/phase9/a6-mumu-evidence.json`. After the user confirmed QQ Music had left the foreground, the resumed check reused the already-installed isolated Calculator package on the same dynamically discovered MuMu instance.

The default `uiautomator dump` output described NovaLauncher on display 0, not Calculator on display 6. In the independent UiAutomator probe, `UiAutomation.getWindowsOnAllDisplays()` returned no windows until the active automation service enabled `AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS`. Android's API reference states this flag is required to enumerate interactive windows ([API reference](https://developer.android.com/reference/android/accessibilityservice/AccessibilityServiceInfo#FLAG_RETRIEVE_INTERACTIVE_WINDOWS)). With the flag enabled, the probe found the active and focused Calculator window on display 6 and captured the target package tree: 33 raw nodes (32 distinct attribute sets), 22 text nodes, and 20 clickable calculator buttons; every node was within 1080×1920 bounds. The runner completed `OK (1 test)`.

This confirms real-device hierarchy availability for the isolated app. The production `dump_ui_hierarchy` implementation was not changed and remains limited by its default-display dump path; no claim is made that the generic tool now handles secondary displays. All device-side probe files were removed. The local temporary compiler workspace `.tmp/phase9/a6-uiautomator` remains because the automatic command policy rejected deleting it; the evidence JSON records its inventory. Full evidence is `.tmp/phase9/a6-mumu-resume-evidence.json` and `.tmp/phase9/a6-mumu-resume-hierarchy.xml`.

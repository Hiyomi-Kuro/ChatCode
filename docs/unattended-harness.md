# Unattended development authorization

`autoWritable` controls direct file edits. It does not grant process execution. `unattendedDev` is a separate, one-time local authorization for selected development tasks.

## Configure a workspace

1. Add a project through the ChatCode loopback management page and explicitly select **autoWritable** for ordinary file edits.
2. On that workspace card, choose the unattended execution settings. Select only existing `package.json` scripts, fixed command templates, Android project-relative Gradle tasks, optional Git read-only access, and (if needed) one MuMu instance returned by current discovery. Git commit/worktree and destructive file lifecycle are separate extra confirmations (`gitWrite` and `fileLifecycle`).
3. Review the scope and the Windows execution warning, then confirm. The server stores an authorization ID, creation time, workspace-root binding, npm package/script hashes, Android project/task allowlist, selected MuMu identity, and executor information. The local API is protected by same-origin and CSRF checks. MCP exposes no tool to grant or widen this authorization.
4. Use **Revoke execution authorization** on the workspace card to remove the grant. Switching the workspace away from `autoWritable` also clears it. Revocation prevents newly requested or not-yet-started tasks from running. Use the task page's cancel control to stop a task that is already running.

Allowed npm script names are selected from the current `package.json`; the saved script and package hashes must still match when the task is requested and started. Android is limited to `assembleDebug`, `testDebugUnitTest`, and `lintDebug` for the exact authorized project-relative directory. Fixed commands use ChatCode-defined executable and argument templates; no model-supplied shell text, executable, cwd, or environment is accepted. MuMu controls are bound to a selected VM index plus its name, Android version, ADB host and port. If the VM changes, the operation fails until the local user reauthorizes it.

### Git write and file lifecycle scopes

`gitWrite` requires `gitReadOnly` and a separate local confirmation. `git_preview_commit` captures the selected author, message, branch HEAD, exact file versions and a text Diff or binary hashes. `git_commit` constructs a temporary index from HEAD containing only those paths and compare-and-swaps the originally previewed branch. Retrying a durable `request_id` does not create a second commit. Hooks do not run; push, force, reset and clean are not available. Worktrees use a generated path under ChatCode's temp directory, carry durable ownership records, and can be removed only when clean, including ignored/untracked content. The branch remains after removal.

`fileLifecycle` separately enables move/rename/soft-delete and recovery. Each operation checks a fresh manifest and journals its intent/verified results. Soft-delete content is held in `DATA_DIR` so `clean:tmp` cannot remove a recovery copy. Multi-file operations can report `partial_commit`/`recovery_required`; Windows does not provide a multi-file atomic transaction, and a cross-volume move is copy/verify/delete with possible compensation.

## Task lifecycle

For a matching grant, a request is persisted as `queued`, audited, and returns a task ID without waiting for the process to finish. The host can poll `get_task` and `get_task_output`; output is paginated and bounded. Terminal states include `succeeded`, `failed`, `timed_out`, `cancelled`, and `interrupted`. Android worker logs remain under the authorized project's `.tmp/logs`. `cancel_task` requests process-tree cancellation; if ChatCode restarts, Android task state and logs can still be queried.

When the scope is missing or no longer matches, the request fails with a reason and does not create a pending approval task. In legacy `writable` workspaces, per-task approval remains available. An existing `autoWritable` grant is not upgraded during migration. The UI keeps old awaiting-approval records in a historical section rather than auto-approving them.

## Windows boundary

There is no Windows Sandbox, AppContainer, or isolated-user execution backend in this version. Authorized npm scripts and Gradle project code run as the current Windows user and may reach files that user can access. Cwd and cache separation are not OS isolation. Do not grant an untrusted project unattended execution. Unrestricted PowerShell/cmd text, system configuration, credential access, workspace-external paths, destructive Git operations, and MuMu deletion/reset are not exposed by the MCP runner.

ChatGPT platform tool confirmations are separate from ChatCode's local approval queue. This profile does not change ChatGPT account, workspace, or tool-confirmation policy.

## Audit and support

Grant/revoke, authorized queue/start/failure, cancellation, and completion events are recorded in the local audit log. `get_harness_status` reports the active profile, authorized categories, and `os_isolation: none`; it does not expose credentials. If a task is rejected, inspect the workspace card and task detail, check whether the project/script hash changed, then update the local scope if that change is intended.

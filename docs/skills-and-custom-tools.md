# Codex Skills and custom tool packages

## Read-only Codex Skills

ChatCode checks `CODEX_HOME/skills` first and falls back to `%USERPROFILE%\.codex\skills`. It validates the configured root and every traversed path, rejects symlinks/reparse points and paths escaping the selected root, and does not scan `.system` by default. Skill `SKILL.md` frontmatter supplies a bounded name and description. Each discovered skill is indexed with source and SHA-256; resource names are paginated rather than returned as full file contents.

Use the MCP tools:

- `list_skills` — list metadata, source, status, and the first resource page.
- `get_skill` — retrieve one skill's metadata and a bounded resource-list page.
- `read_skill_resource` — read an indexed text resource by byte/character page and limit.
- `refresh_skills` — re-scan the local root and invalidate the in-memory index.

The provider excludes executable scripts, sensitive filenames, linked resources, hidden folders, unsupported binary formats, and oversized resources. A hash is checked again before a resource is read. Skill text is untrusted reference data: it cannot add a workspace, grant unattended execution, or make ChatCode run a script. The provider never copies, moves, or edits the user's Codex Skills directory.

## Static custom-tool registry

Packages live in `tools/<package-id>/manifest.json`. A manifest describes the ID/namespace/version, action names and JSON schemas, declared permission hints, dependencies, project/device scopes, timeouts, and red lines. The source-controlled allowlist and strict Zod schemas in `apps/server/core/custom-tools.mjs` determine which code can execute; a new folder or workspace-provided JavaScript is not loaded automatically.

Current packages:

| Package | Actions | Purpose |
|---|---:|---|
| `android` | 4 | Existing Android environment, build request/run, and APK artifact APIs routed through the registry |
| `mumu` | 13 | Local instance discovery/status, selected-instance ADB, package install/launch/stop, scoped UI, screenshots, hierarchy, logcat, and crash diagnostics |
| `project-summary` | 1 | Bounded read-only project summary used as a small non-Android example |

The original 42 MCP tool names are preserved. The current server adds the Skills tools, custom-tool metadata/status tools, `project_summary`, and MuMu actions. Compare `tools/list` with `get_tool_catalog` after changes; schema changes require an MCP reconnect. The local admin action **Reload manifests** reads manifest metadata but does not import new code. The MCP surface cannot reload executable code or grant permissions.

To add a package, add its manifest to the static `manifestFiles` map, define each strict Zod schema and source-controlled action mapping, register its tool names in `mcp.mjs`, add permission and scope checks at the executor boundary, document its red lines, and add tests for success, invalid input, missing handler, manifest collision/version, permission denial, and audit behavior. The manifest permission field is descriptive; handlers must enforce authorization themselves.

## Android and MuMu constraints

Android package tools accept only the fixed Gradle task set. MuMu discovery calls the installed `mumu-cli version` and `mumu-cli info -v all`; the selected identity is compared again before each device action. It never selects an Android Studio Emulator or arbitrary ADB serial. APK install requires a successful, published, hash-checked `assembleDebug` task from the same authorized project. UI input is limited to bounded tap/text/key actions on the target app's logical display. Screenshots map that display to the physical ID reported by MuMu; hierarchy output is accepted only when it contains the target package. See [`mumu-acceptance.md`](mumu-acceptance.md).

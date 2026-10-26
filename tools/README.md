# ChatCode custom tools

Tool packages live under `tools/<package-id>/manifest.json`. Manifests describe package identity, version, JSON input schemas, permission hints, required executables, path/device scope, timeouts, and red lines. Runtime action modules are source-controlled and imported through the registry allowlist in `apps/server/core/custom-tools.mjs`; ChatCode never loads executable JavaScript from a workspace or remote source.

The `android` package is the first compatibility package and routes the existing Android MCP calls through the registry while preserving their public names. `project-summary` is a small read-only package that demonstrates the same registry without Android-specific assumptions.

File lifecycle, LSP, ripgrep, Git, and Agent DAG remain first-party MCP capabilities in `apps/server/core`; they are not custom-tool packages. Their MCP schemas and security details are recorded in [`../docs/phase9-resume-report.md`](../docs/phase9-resume-report.md).

To add a package, add its manifest and a static handler entry to the registry allowlist, provide strict Zod input validation, document every action and permission, then cover the handler with tests. `reload_custom_tools` re-reads manifests and reports whether an MCP reconnect is needed; it does not import newly discovered code at runtime. Package enablement and any permission changes remain local administration actions.

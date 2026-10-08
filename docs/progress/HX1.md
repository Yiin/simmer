# HX1: OpenCode harness

2026-10-08T03:53:08Z Claimed simmer-kag.2 on main-pc, branch wt/HX1. Beads uses the shared simmer database.

Installed OpenCode is 1.18.32. PATH resolves to the mise binary. Installed help confirms run, --format json, --auto, and --agent.

The probe runs in /tmp/HX1-probe with empty stdin, a 120-second timeout, and OPENCODE_PERMISSION='{"*":"allow"}'. It must create one file and read it through the shell.

Sources: https://opencode.ai/docs/cli/ and https://opencode.ai/docs/permissions/. The CLI docs define OPENCODE_PERMISSION. Permission docs define the allow rule and external_directory behavior.

2026-10-08T03:55:15.304965+00:00 Probe passed with exit 0. It created hello.txt and ran cat hello.txt without approval.

Captured step_start, tool_use, step_finish, and text events. Trimmed fixtures remove private paths, provider metadata, timestamps, and session IDs.

An invalid provider probe exited 1 and returned a JSON error event. It made no model request. The error fixture preserves that event shape.

The adapter uses run --format json --auto --agent build and OPENCODE_PERMISSION. It joins text parts for the last message. It sums per-step tokens and deduplicates step IDs. Reasoning tokens count as output because OpenCode reports them separately.

Focused adapter tests passed: 12 tests, zero failures. Frozen dependency install passed. Shared process.ts and config.ts remain unchanged.

2026-10-08T03:55:35.039736+00:00 The first full gate found a shared test typing issue.

test/harness.test.ts declared its three-harness list as all Harness values. Adding a registry entry widened its index type beyond its three-entry fixture map. Changed that declaration to satisfies Harness[]. The list and runtime behavior stay the same. No shared production code changed.

2026-10-08T03:59:36.111817+00:00 Full gate passed: frozen install, typecheck, lint, 307 tests, zero failures.

Live smoke run 1 found a cwd defect. OpenCode reads process.env.PWD before process.cwd(). Simmer starts the worker with cwd set, but PWD still names the main checkout. The worker wrote and committed hello.txt there. Its linked worktree stayed unchanged.

Version source confirms the cause: https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/cli/cmd/run.ts. The root assignment uses Filesystem.resolve(process.env.PWD ?? process.cwd()). Added the installed --dir flag with the absolute worktree path. No shared process change is needed. Invocation tests now require --dir.

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

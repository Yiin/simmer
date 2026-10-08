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

2026-10-08T04:00:20.587339+00:00 Smoke run 1 eventually passed on retry.

Attempt 1 took 42.722 seconds and reported 310278 tokens. Attempt 2 took 138.857 seconds and reported 1225298 tokens. The retry detected the worktree and created a commit there. A fresh smoke run now checks the --dir fix from the start.

2026-10-08T04:02:39.227709+00:00 The --dir smoke passed on attempt 1 with OpenCode 1.18.32.

Duration: 86.347 seconds. Tokens: input 32020, output 2515, cache read 293888, cache write 0, total 328423. These numbers cover the worker. Separate Claude reviewer calls are not included.

PASS verified exit 0, exact hello.txt on main, and a closed child. The smoke command removed its temporary repository. PATH used the installed mise binary, so no harnessPaths override was needed.

The fixed gate passed: frozen install, typecheck, lint, and 307 tests with zero failures. No changes were needed in process.ts or config.ts. The extra Claude smoke condition does not apply.

Review folder: /var/tmp/claude-1000/-home-yiin/e4ceb278-5205-4592-9266-27563968e136/scratchpad/HX1-review/. No follow-up bead is needed. No coordinator decision is needed.

2026-10-08T04:05:33.001361+00:00 The post-rebase gate hit the known pipeline test timeout during concurrent lane gates.

The unchanged test three claims lost during the pipeline do not trigger the fatal error limit took 9537.19 ms against its 5000 ms limit. All other tests passed. The two earlier gates passed the same test. Three bun test processes overlapped. The gate will run again after the other suites finish. No timeout or behavior change is needed.

HX2 merged Gemini at 09f9892 while the gate ran. Rebase will keep both harness entries and README rows.

2026-10-08T04:06:59.324342+00:00 Rebased onto Gemini and Kimi. Their registry entries and README rows remain present.

The other test suites finished before this gate. The final tree changes seven files. The shared test typing fix already exists on main through HX2, so it is absent from the final HX1 diff. Shared production process and config code remain unchanged.

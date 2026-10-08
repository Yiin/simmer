# HX3: Cursor CLI harness

2026-10-08T03:53:00Z Claimed simmer-kag.4. Read the lane rules, HX0 recipe, adapters, and relevant skills.

2026-10-08T03:54:04Z Cursor authentication blocks implementation. Machine checks identified main-pc and its personal tailnet.

The installed binary is `/home/yiin/.local/share/mise/installs/cursor-agent/latest/bin/cursor-agent`, version `2026.10.01-e373342`. PATH selects this binary.

Installed help confirms print mode has write and shell tools. It lists `--output-format stream-json`, `--force`, `--sandbox disabled`, and `--trust`.
[Cursor headless docs](https://cursor.com/docs/cli/headless) confirm unattended file modification with print mode and force.
[Output format docs](https://cursor.com/docs/cli/reference/output-format) describe assistant messages and terminal result events.

One probe ran outside simmer in a temporary directory:

```sh
cursor-agent -p --output-format stream-json --force --sandbox disabled --trust 'Create hello.txt containing exactly cursor probe ok followed by a newline. Use the shell to verify it with cat hello.txt. Reply only: Cursor probe complete.'
```

The probe exited 1 after 0.415 seconds. It emitted no event stream. Its exact stderr was:

```text
Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.
```

No token usage was reported. No adapter or fixture was created. No smoke run or quality gate ran.
Lane rules require stopping on authentication failure. Global CLI config and authentication remain unchanged.

2026-10-08T03:54:19Z Filed simmer-kag.9 for authentication. Marked simmer-kag.4 blocked and added that dependency.
Recommend that the coordinator arrange authentication or provide CURSOR_API_KEY through the approved environment. Resume HX3 afterward.

Review page: `/var/tmp/claude-1000/-home-yiin/e4ceb278-5205-4592-9266-27563968e136/scratchpad/HX3-review/index.html`.
No merge or push. Keep wt/HX3 and its worktree for resume.

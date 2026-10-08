# HX4: Kimi harness

2026-10-08T03:54:31.299453+00:00 Claimed simmer-kag.5. Kimi 2.0.0 resolves to /home/yiin/.kimi-code/bin/kimi.

The first probe rejected `--auto -p` with exit 1: `error: Cannot combine --prompt with --auto.`

The official command reference states that prompt mode uses auto permission by default. The second probe uses `kimi -p <prompt> --output-format stream-json`.

Reference: https://moonshotai.github.io/kimi-code/en/reference/kimi-command.md

2026-10-08T03:55:25.560218+00:00 Blocked by Kimi Code subscription access. The corrected prompt probe exited 1.

Invocation: `kimi -p "Create hello.txt containing exactly kimi probe ok followed by a newline. Use a shell command to check its contents. Finish with the exact text: kimi probe done" --output-format stream-json`.

The probe ran with empty stdin through /home/yiin/.kimi-code/bin/kimi in a temporary directory. No authentication or global config was changed.

Exact error:

```text
error: failed to run prompt: provider.auth_error: 403 Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://www.kimi.com/code/#pricing
```

Only the version event reached stdout:

```json
{"role":"meta","type":"system.version","version":"2.0.0"}
```

No assistant message or token usage was reported. hello.txt was not created. A success fixture cannot be captured from this probe.

Smoke runs: 0. Smoke duration: unavailable. The required live smoke cannot run until access returns.

Gate: not run because only this lane log changed. No adapter, registry entry, parser test, or README row was added. Merge and push: not run because the adapter scope is blocked.

Keep wt/HX4 and its worktree for the next probe. Recommend restoring the existing subscription, then resume simmer-kag.5.

2026-10-08T03:55:35.349568+00:00 Filed simmer-kag.10 for subscription access. simmer-kag.5 remains blocked and open.

Review page: /var/tmp/claude-1000/-home-yiin/e4ceb278-5205-4592-9266-27563968e136/scratchpad/HX4-review/index.html

2026-10-08T03:58:31.543631+00:00 HX4b resumed simmer-kag.5 as in_progress. Host is main-pc. Installed CLI remains /home/yiin/.kimi-code/bin/kimi 2.0.0.

Per-run auth is supported by KIMI_MODEL_NAME, KIMI_MODEL_API_KEY, and KIMI_MODEL_BASE_URL. Confirmed in the installed binary's config/env-model implementation and official docs: https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html.

KIMI_API_KEY on https://api.kimi.com/coding/v1 with kimi-for-coding still returns the subscription 403. MOONSHOT_API_KEY lists kimi-k3 on https://api.moonshot.ai/v1. The same key fails authentication on the .cn endpoint.

Successful probe used KIMI_MODEL_NAME=kimi-k3, KIMI_MODEL_BASE_URL=https://api.moonshot.ai/v1, KIMI_MODEL_API_KEY from get-token MOONSHOT_API_KEY, and KIMI_CODE_NO_AUTO_UPDATE=1. Invocation: kimi -p <prompt> --output-format stream-json. Exit 0. hello.txt contains the exact line. Write and Bash tools ran without approval. No global config or login change.

The fixture keeps the real version, tool calls, tool results, and final assistant message. It omits the resume hint. No paths or secrets appear. Kimi 2.0.0's PromptJsonWriter emits no token usage. The adapter will leave usage undefined.

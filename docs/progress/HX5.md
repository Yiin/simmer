# HX5: Crush harness

2026-10-08T03:54:31.071475+00:00 Claimed simmer-kag.6. Read lane rules. Host main-pc. Crush v0.96.1 comes from mise.

Installed help lists `crush run --quiet --cwd <path> <prompt>` and root-only `--yolo`. No JSON output flag exists. The probe will check plain text output and unattended file and shell access.

2026-10-08T03:55:54.524845+00:00 BLOCKED. The failed flag probe returned exit 1 with `Unknown flag: --yolo.` Root-only `--yolo` does not work with `run` in this installed version.

The v0.96.1 source confirms that embedded `RunNonInteractive` calls `app.Permissions.AutoApproveSession(sess.ID)`. Set `CRUSH_CLIENT_SERVER=0` per run to select that path. No `--yolo` flag is needed there. Source: https://github.com/charmbracelet/crush/blob/v0.96.1/internal/app/app.go .

The corrected probe used `CRUSH_CLIENT_SERVER=0 crush run --quiet --cwd <temp-dir> <prompt>`. It returned exit 1 with the exact error:

```text
No providers configured - please run 'crush' to set up a provider interactively.
```

No assistant output or token usage exists. No file was created. The probe logs remain at `/tmp/HX5-crush-probe-HacAdN`. No credentials, tokens, or global settings changed.

Stopped at the required provider blocker. No adapter, registry entry, fixture, or README row was added. No simmer smoke ran. No gate ran because no code changed. No merge or push occurred.

Recommendation: the owner must configure a Crush provider through the normal interactive setup. Resume HX5 afterward. The headless permission path exists, so this is not a won't-fix result.

Review page: `/var/tmp/claude-1000/-home-yiin/e4ceb278-5205-4592-9266-27563968e136/scratchpad/HX5-review/index.html`.

2026-10-08T03:56:27.302416+00:00 Filed simmer-kag.11 for owner provider setup. Added it as a dependency of simmer-kag.6. Marked simmer-kag.6 blocked. Keep wt/HX5 and its worktree for resumption.

2026-10-08T04:02:34.375073+00:00 HX5b resumed under the coordinator's per-run provider decision. Set simmer-kag.6 in_progress. Host main-pc, mise Crush v0.96.1.

The live probe passed with `CRUSH_CLIENT_SERVER=0 crush run --quiet --cwd <temp-repo> --model anthropic/claude-haiku-4-5-20251001 --small-model anthropic/claude-haiku-4-5-20251001 --data-dir <temp-data> <prompt>`. Crush wrote probe.txt and committed it. Stdout contains only two requested final text lines. No token usage or JSON event format exists in this mode.

Provider setup used ANTHROPIC_API_KEY from get-token inside the same shell call. A temporary crush.json references `$ANTHROPIC_API_KEY`. CRUSH_GLOBAL_CONFIG, CRUSH_GLOBAL_DATA, and CRUSH_CACHE_DIR point outside the repo. The owner's config remains unchanged. Two setup attempts failed before API use: the config override needs a directory, and the installed model catalog needs the dated Haiku model ID. Closed simmer-kag.11 because temporary provider setup removes the owner action.

Source confirms embedded non-interactive runs auto-approve all session permissions. `--yolo` is root-only and cannot be used with `run`. Source: https://github.com/charmbracelet/crush/blob/v0.96.1/internal/app/app.go .

Shared change required: runProcess currently accepts JSON lines only. Add an optional text output mode for Crush. Keep its watchdog, abort, exit handling, and JSON parsing. This requires one Claude smoke run.

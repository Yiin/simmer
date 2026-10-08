# HX0: harness registry and smoke script

2026-10-08T03:42:04.792773+00:00 Claimed simmer-kag.1. Read lane rules and project instructions.

Registry wiring will preserve Claude, Codex, and Pi behavior. Smoke databases must stay local.

2026-10-08T03:45:32.471096+00:00 Committed registry wiring and the smoke command. Existing adapters and process code are unchanged.

Local Beads probe passed in embedded mode with loopback routing. Global issue-prefix overrode the scratch prefix on the first setup. Added issue-prefix: smoke to the local config. No worker ran in that failed setup.

The smoke command reads attempt JSON from the issue notes field. It runs this checkout with --worktree and --json. Claude session markers are cleared only for this run.

2026-10-08T03:48:38.028830+00:00 Live smoke results:

| Harness | Version | Result | Attempt duration | Tokens |
|---|---|---|---|---|
| claude | 2.1.282 | PASS | 35.043 s | 224455 |
| codex | 0.154.0 | FAIL | 9.190 s + 8.703 s | unknown |
| pi | 1.0.4 | PASS | 141.552 s | 330930 |

Tokens sum uncached input, output, cache reads, and cache writes from each worker attempt note. They do not include separate reviewer processes. Missing usage is unknown, not zero.

Claude and Pi produced the exact hello.txt on main and closed the child. Both scratch directories were removed. Codex scratch directory remains at /var/tmp/simmer-smoke-codex-o5H1vC.

Codex attempts exited without commits or usage. A separate read-only CLI diagnostic returned HTTP 400: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." Evidence: /tmp/HX0-codex-diagnostic.jsonl and the scratch run.log. Filed simmer-kag.8 under simmer-kag. Recommend a supported default model or a per-run worker model override in a separate task. No adapter change belongs in HX0.

The first frozen install and gate passed: 292 tests, zero failures. A second gate checks the final tests. The required gate runs again after the final commit and rebase.

Diff review confirmed no changes to claude.ts, codex.ts, pi.ts, process.ts, or child.ts. Production changes only wire the registry into config, dispatch, and CLI help and validation.

The smoke command uses embedded Beads, a forced local BEADS_DIR, loopback host, and port 1. Local config fixes the prefix and disables backups and remote sync. No shared database was created.

Automatic approval review rejected rm -rf for the local probe. The replacement checks its exact path and project ID before cleanup.

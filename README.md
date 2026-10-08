# simmer

simmer runs a bd epic unattended. It takes one ready child at a time, hands it to a fresh headless agent in its own worktree, checks the result, and lands it on the base branch. bd is the only state store, so a crashed run resumes by running the same command again.

It runs on seven harnesses: Claude Code, Codex, Pi, Gemini CLI, Kimi, OpenCode, and Crush. Each one uses your own login or API key for that CLI.

It replaces `t3 epic cook`. It does not need t3code, forge, or a server.

## What it does and does not do

simmer runs children one after another. It never needs a clean primary checkout. It never stops a whole run because one child failed.

Parallel work belongs to an orchestrator (forge, or a coordinator agent). The orchestrator decides how many children run at once, creates and removes worktrees, and assigns children. It calls `simmer child` once per assignment.

The per-child pipeline (plan, plan review, implement, review, QA) lives in the `cook-it` skill, not in simmer. The worker model decides each routing call. simmer enforces only facts it can check: the gate is green, a commit exists, the bead is closed.

## Commands

```
simmer run <epic>                 run every ready child, one at a time, until none is left
simmer child <bead> [--worktree <path>] [--no-land]
                                  run one child; for orchestrators
simmer status <epic>              print progress from bd
```

Common flags: `--harness claude|codex|pi|gemini|kimi|opencode|crush`, `--json` (one JSON event per line on stdout, for forge).

## One child, step by step

1. **Claim.** Take a bd claim lease on the child with a compare-and-set guard (`--if-status open`). A heartbeat renews the lease while the worker runs. A lease from a dead run expires and the next run reclaims it.
2. **Worktree.** Create a worktree at the run branch tip (`simmer/<epic>`), or use the one the orchestrator passed. The primary checkout is never touched, so its uncommitted files do not matter.
3. **Work.** Start the harness headless in the worktree with the `cook-it` prompt for this child. Stage roles use the selected harness's model config.
4. **Check effects.** Ignore what the worker says it did. Look for new commits on the worktree branch and a closed bead.
5. **Gate.** Run the project's gate command in the worktree.
6. **Retry once.** A red gate or a missing commit gets one fresh worker with the failure output in its brief. A second failure marks the child blocked with a bd note, and the run moves on to the next ready child.
7. **Land.** Rebase onto the run branch, then fast-forward it. Then try to fast-forward the base branch (see below).

A watchdog kills a worker that prints nothing and makes no commit for the configured time. That counts as one failed attempt.

## Landing next to a dirty checkout

The base branch is often checked out in the primary worktree, with unrelated uncommitted files in it (a changed `package-lock.json`, a local config). simmer lands like this:

- If no worktree has the base branch checked out, simmer updates the branch ref directly.
- If the primary worktree has it checked out, simmer runs `git merge --ff-only` there. Git allows this when the dirty files do not overlap the incoming changes.
- If they overlap, simmer does not stop. It records "landing deferred" with the file names, keeps building on the run branch, and retries the landing after the next child and at the end of the run.
- If the config sets `push: true`, simmer pushes the base branch after it lands.

## State

All durable state is in bd:

- the claim lease and status on each child,
- one bd note per attempt (harness, model, duration, tokens, gate result, commits),
- one bd note on the epic per landing or deferral.

Nothing is kept in memory across commands. `simmer run <epic>` after a crash finds expired leases, reclaims them, and continues.

## Config

`simmer.json` in the project root:

```json
{
  "base": "main",
  "gate": "bun run typecheck && bun run test",
  "push": false,
  "harness": "claude",
  "watchdogMinutes": 20,
  "models": {
    "claude": {
      "planner": "opus",
      "implementer": "sonnet",
      "reviewer": "opus",
      "tester": "opus"
    },
    "codex": { "reviewer": "claude:opus" },
    "pi": { "reviewer": "claude:opus" }
  }
}
```

`models` maps each harness to its cook-it stage models. Claude defaults to `opus` for planner, reviewer, and tester, and `sonnet` for implementer. The other harnesses default to `claude:opus` for reviewer. Their other roles have no model hint and use the current harness defaults. Partial maps inherit defaults only for their own harness. A `--harness` override selects that harness's map.

In the maps of the other harnesses, `claude:<model>` runs that role as a one-shot Claude Code process. For example, setting `models.codex.reviewer` to `claude:sonnet` selects Claude Sonnet for review. simmer prints a complete script that writes the brief to a temporary file and runs `claude -p --model sonnet --permission-mode bypassPermissions "$(cat "$brief")" < /dev/null`. The script uses `claude` from `PATH`, not `harnessPaths.claude`. It removes the temporary file when the process exits. Claude role briefs must forbid repository edits. The main worker applies proposed changes. The worker watchdog covers these Claude role processes. A silent process can reach `watchdogMinutes` and trigger the watchdog.

Claude receives role definitions through `--agents` JSON. Its map accepts plain model names, such as `opus`, and rejects `claude:<model>`. The other harnesses receive stage instructions in their prompts. Plain model hints stay in the selected harness. Set a plain reviewer model to use the selected harness for review. A hint that the harness cannot run does not select another harness. simmer does not generate Pi subagent config.

simmer validates the config shape and non-empty model names. A `claude:` suffix must name a model without control characters or a leading `-`. It does not check provider availability. Flat role maps are invalid. Review model reports require verified process output or session metadata. Add `--output-format json` to the printed Claude command to inspect `modelUsage`. If the output does not identify the model, report it as unknown. The requested model and the model's own description do not prove which model ran.

## Harnesses

| Harness | Invocation |
|---|---|
| Claude Code | `claude -p --output-format stream-json --agents <json>` |
| Codex | `codex exec --json -s danger-full-access` (the workspace-write sandbox cannot write a worktree's git dir) |
| Pi | `pi -p --mode json` with stage instructions in the prompt |
| Gemini CLI | `gemini -p "<prompt>" --output-format stream-json --approval-mode yolo --sandbox=false --skip-trust` |
| Kimi | `kimi -p "<prompt>" --output-format stream-json` with stage instructions in the prompt; prompt mode auto-approves |
| OpenCode | `OPENCODE_PERMISSION='{"*":"allow"}' opencode run --format json --auto --agent build --dir "<worktree>" "<prompt>"` with stage instructions in the prompt |
| Crush | `CRUSH_CLIENT_SERVER=0 crush run --quiet --cwd <path> <prompt>` with stage instructions in the prompt. Plain text output; token usage is not reported. |

Each adapter returns the exit status, the final message, and token usage.
`src/harness/registry.ts` defines each harness name, default binary, run function, and default role models.
Config validation, config defaults, dispatch, and CLI help use this registry.

### Add a harness

1. Add `src/harness/<name>.ts` with `run(options: RunOptions)`. Use `runProcess` to read its event stream. Use `rolePrompt` for stage instructions when the CLI does not support Claude's role agents.
2. Add one entry to `src/harness/registry.ts`. Set `defaultBinary`, `run`, and `defaultModels`. Use `{ reviewer: 'claude:opus' }` for the default reviewer on non-Claude harnesses.
3. Add adapter tests in `test/harness.test.ts` or a new test file. Cover invocation, final text, usage, and failure handling.
4. Add one row to the harness table above.
5. Run `bun install --frozen-lockfile && bun run gate`.
6. Run `scripts/smoke-harness.sh <name>` with the CLI installed and authenticated.

The smoke command uses this checkout's `src/cli.ts`. It creates a temporary Git repo and an embedded Beads database.
It gives one child a one-line file task and runs `simmer child` with a 20-minute timeout.
PASS requires exit 0, the exact file contents on `main`, and a closed child.
The command prints the CLI version, duration, and token usage from each attempt note.
Token totals include uncached input, output, cache reads, and cache writes. Missing usage prints as unknown.
It removes the temporary directory on PASS and keeps logs and the database on FAIL.
It disables remote Beads routing for the run and never uses the shared Dolt server.

## Install

```
curl -fsSL https://raw.githubusercontent.com/Yiin/simmer/main/scripts/install.sh | bash
```

From a clone, `bash scripts/install.sh` does the same. It clones or updates `~/Projects/simmer`, installs dependencies, writes the `~/.local/bin/simmer` shim, and points the `cook-it` and `cook-epic` skills in `~/.agents/skills` and `~/.claude/skills` at this repo. Run it again to update. To install on another machine: `ssh <host> 'bash -s' < scripts/install.sh`.

## Requirements

- bd 1.3.1 or later (claim leases and compare-and-set)
- git 2.40 or later
- bun

# simmer

simmer runs a bd epic unattended. It takes one ready child at a time, hands it to a fresh headless agent in its own worktree, checks the result, and lands it on the base branch. bd is the only state store, so a crashed run resumes by running the same command again.

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

Common flags: `--harness claude|codex|pi`, `--json` (one JSON event per line on stdout, for forge).

## One child, step by step

1. **Claim.** Take a bd claim lease on the child with a compare-and-set guard (`--if-status open`). A heartbeat renews the lease while the worker runs. A lease from a dead run expires and the next run reclaims it.
2. **Worktree.** Create a worktree at the run branch tip (`simmer/<epic>`), or use the one the orchestrator passed. The primary checkout is never touched, so its uncommitted files do not matter.
3. **Work.** Start the harness headless in the worktree with the `cook-it` prompt for this child. Stage subagents get their models from the config.
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
    "planner": "opus",
    "implementer": "sonnet",
    "reviewer": "opus",
    "tester": "opus"
  }
}
```

`models` maps cook-it stage roles to models. simmer turns it into each harness's subagent definitions: `--agents` JSON for Claude Code, and pi-subagents config for Pi.

## Harnesses

| Harness | Invocation |
|---|---|
| Claude Code | `claude -p --output-format stream-json --agents <json>` |
| Codex | `codex exec --json -s danger-full-access` (the workspace-write sandbox cannot write a worktree's git dir) |
| Pi | `pi -p --mode json` with pi-subagents |

Each adapter returns the exit status, the final message, and token usage.

## Install

```
bash scripts/install.sh
```

It clones or updates `~/Projects/simmer`, installs dependencies, writes the `~/.local/bin/simmer` shim, and points the `cook-it` and `cook-epic` skills in `~/.agents/skills` and `~/.claude/skills` at this repo. Run it again to update. To install on another machine: `ssh <host> 'bash -s' < scripts/install.sh`.

## Requirements

- bd 1.3.1 or later (claim leases and compare-and-set)
- git 2.40 or later
- bun

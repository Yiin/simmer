---
name: cook-epic
description: "Run a beads epic unattended with simmer, one fresh-context worker per child. Use when the user types /cook-epic <epic id>."
---

# cook-epic

Run every ready child of a beads epic with `simmer`. simmer takes one ready child at a time, hands it to a fresh headless worker in its own worktree, checks what the worker left behind, runs the gate, and lands the work on the base branch. bd holds all run state, so a crashed run resumes when you run the same command again.

Each worker cooks its child with the `cook-it` skill. cook-it owns the per-child pipeline (plan, review, QA). simmer only enforces facts it can check: the worker made commits, the bead is closed, and the gate is green.

## When to use it

- The epic has children with real `bd` dependencies, so `bd ready --parent <EPIC>` returns claimable work.
- The user wants the epic run unattended.
- The repo has a scriptable gate (typecheck, build, test). Workers run only cheap checks, so the gate is the one full scripted check.

Use `/cook-it` for a single issue. If no epic exists yet, see "No epic yet" below.

## Preflight

Check all of these before you launch. If one fails, report it and fix it instead of launching.

1. You are at the project root and `.beads/` exists.
2. `bd show <EPIC>` finds the epic, and `bd list --parent <EPIC>` shows open children.
3. `bd ready --parent <EPIC> --json` is not empty. If open children exist but none are ready, they wait on dependencies. Report the blockers from `bd blocked` and do not launch.
4. `simmer --version` prints a version.
5. `simmer.json` exists in the project root, or the defaults fit this repo. The defaults are base `main`, gate `bun run typecheck && bun run test`, `push: false`, harness `claude`, and a 20-minute watchdog. If the default gate does not match the repo, write a `simmer.json` with the right gate. Derive it from CI config, `package.json` scripts, or `AGENTS.md`, and state your choice in the launch report.

Do not require a clean working tree. simmer never touches the primary checkout while a worker runs. Uncommitted files there do not block a run.

**Harness.** simmer uses the harness from `simmer.json`. Pass `--harness claude|codex|pi|gemini|kimi|opencode|crush` only when the user names one, or when the config leaves it unset and you run inside a harness other than Claude Code.

**Push.** simmer pushes the base branch after each landing only when `simmer.json` sets `push: true`. Otherwise it lands locally. Say "gated, landed locally" in reports, never "pushed".

## Launch and watch

Start the run detached, so it survives the chat session closing:

```bash
LOG=$(mktemp "/var/tmp/simmer-<EPIC>.XXXXXX.jsonl")
nohup setsid simmer run <EPIC> --json >"$LOG" 2>&1 &
```

`--json` writes one JSON object per line to stdout, with an `event` field. Watch the log with your harness's background monitor (for example, tail it and relay each new line). Relay `claimed`, `landed`, `deferred`, `blocked`, `conflict`, `push-failed`, `claim-lost`, `child-error`, and `run-finished`. Stay quiet on `attempt-started`, `gate`, and `attempt-finished` unless one shows a failure.

`run-finished` carries the exit code: `0` when nothing is left and nothing is deferred, `4` when the run ended with deferred landings or blocked children, `1` on a fatal error. A second `simmer run` on the same epic on the same machine is refused while the first one holds its lock.

To check progress at any time:

```bash
simmer status <EPIC>      # done, blocked, in-flight, and deferred counts from bd
bd show <child>           # one note per attempt: harness, model, duration, tokens, gate result, commits
bd show <EPIC>            # one note per landing or deferral
```

Tell the user once, up front: the epic id, the log path, that the run survives the chat closing, and that `simmer status <EPIC>` shows progress from any session.

To stop a run, kill the `simmer run` process. Its leases expire, and the next run reclaims them.

## Resume after a crash

Run the same command again:

```bash
nohup setsid simmer run <EPIC> --json >"$LOG" 2>&1 &
```

On start, simmer finds expired claim leases from the dead run, reclaims those children, and continues. Children that already landed stay landed. Do not release claims by hand, and do not clean the worktree of a child whose lease is still live. A live lease means a worker still owns it.

## Parallel children

`simmer run` is serial. Parallel work belongs to an orchestrator (forge, or a coordinator agent). The orchestrator decides how many children run at once, creates and removes the worktrees, and calls `simmer child` once per assignment:

```bash
git worktree add -b work/<child> ../wt-<child> <base>
simmer child <child> --worktree ../wt-<child> --json
```

The worktree must belong to the same repo, and its branch must be neither the base branch nor `simmer/<EPIC>`. Without `--worktree`, simmer creates and removes its own. `--no-land` stops after the gate and leaves landing to the orchestrator. Exit codes:

| Code | Meaning | Orchestrator action |
|---|---|---|
| 0 | Landed, or landing deferred | Assign the next ready child |
| 2 | Blocked after two failed attempts | Read the bd note on the child, move on |
| 3 | Claim lost to another runner | Drop the assignment |
| 1 | Error | Report it with the output |

Only assign children that `bd ready --parent <EPIC>` returns. Two children that touch the same files can conflict at landing, so prefer children with disjoint scope.

## Blocked children

A child that fails twice (red gate, no commit, bead left open, or watchdog kill) gets bd status `blocked` and a bd note that carries the failure output. The run moves on to the next ready child.

When the run ends, read each blocked child's notes with `bd show <child>`. Then pick one:

- The failure is a real bug in the child's spec. Fix the spec in the bead, reopen it, and run again.
- The child needs a human decision. Report the exact decision to the user.
- The child is fine but flaky. Reopen it and run again.

## Deferred landings

A landing defers when uncommitted files in the primary checkout overlap the incoming changes. simmer records "landing deferred" with the file names on the epic, keeps building on the run branch `simmer/<EPIC>`, and retries after the next child and at the end of the run.

If a landing is still deferred when the run ends, report the overlapping files to the user. Those files may be another agent's work in progress. Never discard or stash them yourself. Once the owner commits or removes them, `git merge --ff-only simmer/<EPIC>` on the base branch lands the work.

## No epic yet

If the user asks to cook work that has no epic, plan one first. If `~/.agents/skills/plan-epic` exists, use the `plan-epic` skill. Otherwise create the epic with `bd create --type epic`, add children with `bd create --parent <EPIC>`, and wire the order with `bd dep add`. Give each child a concrete, followable spec, since a fresh worker sees only the bead.

## When the run finishes

Report:

- why it stopped: no ready children left, or only blocked children remain,
- the children that landed,
- the blocked children and what each needs,
- any landing still deferred, with its files.

simmer does not close the epic. Close it yourself with `bd close <EPIC>` once every child is closed and the work has landed.

## Cautions

- The gate is a script and cannot drive a browser. Integrated QA of a user-visible change happens inside the worker, through cook-it's tester stage, in the worker's own worktree.
- simmer verifies a child by its commits. A research child whose deliverable is a bd comment or note makes no commit. Give it the `research` label (`bd label add <child> research`) before the run. simmer then accepts a closed bead plus a new note or comment in place of a commit.
- A fresh worktree has no installed dependencies. If the gate needs them, put the install in the gate command (for example, `bun install --frozen-lockfile && bun run test`).

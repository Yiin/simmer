#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# != 1 ]]; then
  printf 'FAIL: Usage: scripts/smoke-harness.sh <harness>\n' >&2
  exit 1
fi
harness=$1
checkout=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export SIMMER_CHECKOUT_ROOT="$checkout"
binary=$(bun -e 'const { harnessRegistry, isHarness, harnessChoices } = await import(`${process.env.SIMMER_CHECKOUT_ROOT}/src/harness/registry.ts`); const name = process.argv[1]; if (!isHarness(name)) { console.error(`FAIL: harness must be ${harnessChoices}`); process.exit(1) } console.log(harnessRegistry[name].defaultBinary)' "$harness")
smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/simmer-smoke-${harness}-XXXXXX")
repo="$smoke_dir/repo"
version=unknown
reason='setup failed'
passed=false

finish() {
  status=$?
  trap - EXIT
  if [[ $status != 0 ]]; then
    printf 'FAIL %s: %s (exit %s)\n' "$harness" "$reason" "$status"
  else
    printf 'PASS %s: exit 0, hello.txt on main, child closed\n' "$harness"
  fi
  printf 'Harness version: %s\n' "$version"
  if [[ -f "$smoke_dir/child.json" ]]; then
    bun -e '
      const issues = await Bun.file(process.argv[1]).json();
      const attempts = (issues[0]?.notes ?? "").split("\n").flatMap(text => {
        try { const note = JSON.parse(text); return note.harness && typeof note.attempt === "number" ? [note] : [] } catch { return [] }
      });
      if (!attempts.length) console.log("Attempt note: unavailable; duration and tokens unknown");
      for (const note of attempts) {
        const u = note.usage;
        const tokens = u ? `input=${u.inputTokens} output=${u.outputTokens} cache_read=${u.cacheReadTokens} cache_write=${u.cacheWriteTokens} total=${u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens}` : "unknown";
        console.log(`Attempt ${note.attempt}: duration_ms=${note.durationMs} tokens=${tokens} outcome=${JSON.stringify(note.outcome)}`);
      }
    ' "$smoke_dir/child.json" || true
  else
    printf 'Attempt note: unavailable; duration and tokens unknown\n'
  fi
  printf 'Temp path: %s\n' "$smoke_dir"
  if [[ $passed == true && $status == 0 ]]; then
    rm -rf "${smoke_dir:?}"
    printf 'Temp directory removed.\n'
  else
    printf 'Temp directory kept. See setup.log and run.log.\n'
  fi
  exit "$status"
}
trap finish EXIT
trap 'reason="command failed at line $LINENO: $BASH_COMMAND"' ERR

# Remove ambient Beads routing. Keep the worker CLI authentication unchanged.
while IFS= read -r name; do
  case "$name" in BEADS_*|BD_*) unset "$name" ;; esac
done < <(compgen -e)
export BEADS_DIR="$repo/.beads"
export BEADS_DOLT_SERVER_HOST=127.0.0.1
export BEADS_DOLT_SERVER_PORT=1
export BEADS_DOLT_SERVER_SOCKET=''
export BD_NON_INTERACTIVE=1
# Claude permits independent headless calls when the parent session marker is absent.
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION

version=$(timeout 30s "$binary" --version 2>&1) || version="unavailable: $version"
mkdir -p "$repo/.beads"
chmod 700 "$repo/.beads"
cd "$repo"
git init -q -b main
git config user.name 'Simmer Smoke'
git config user.email 'smoke@simmer.invalid'
git config commit.gpgsign false
cat > .beads/config.yaml <<'CONFIG'
issue-prefix: smoke
dolt:
  host: 127.0.0.1
  port: 1
  user: root
backup:
  enabled: false
sync:
  remote: ""
CONFIG
reason='bd cannot initialize locally; see setup.log'
timeout 60s bd init --prefix smoke --non-interactive --skip-agents --skip-hooks > "$smoke_dir/setup.log" 2>&1
reason='bd did not initialize in embedded mode'
bun -e 'const m = await Bun.file(".beads/metadata.json").json(); if (m.dolt_mode !== "embedded") process.exit(1)'
# Init may infer a remote from global settings. Disable it in this scratch repo.
cat > .beads/config.yaml <<'CONFIG'
issue-prefix: smoke
dolt:
  host: 127.0.0.1
  port: 1
  user: root
backup:
  enabled: false
sync:
  remote: ""
CONFIG
reason='bd cannot create local issues'
epic=$(timeout 60s bd create 'Harness smoke' --type epic --json | bun -e 'console.log((await Bun.stdin.json()).id)')
child=$(timeout 60s bd create 'Create hello.txt containing the single line: simmer smoke ok. Commit it. Close this issue.' --type task --parent "$epic" --json | bun -e 'console.log((await Bun.stdin.json()).id)')
cat > AGENTS.md <<'RULES'
This is a throwaway harness smoke repository.
Use the existing local Beads database. Do not configure a server or remote.
Create only hello.txt with the requested line. Use the gate in simmer.json.
Commit hello.txt, then close the assigned issue. Do not push.
RULES
printf '.beads/\n' > .gitignore
bun -e 'await Bun.write("simmer.json", JSON.stringify({base: "main", harness: process.argv[1], push: false, gate: "grep -qx '\''simmer smoke ok'\'' hello.txt"}, null, 2) + "\n")' "$harness"
git add AGENTS.md .gitignore simmer.json
git commit -q -m 'test(harness): create smoke repository'
git worktree add -q -b smoke-worker "$smoke_dir/worker" main
printf 'Running %s smoke. Temp path: %s\n' "$harness" "$smoke_dir"
reason='simmer child failed; see run.log'
run_exit=0
timeout --kill-after=30s 20m bun "$checkout/src/cli.ts" child "$child" --worktree "$smoke_dir/worker" --json > "$smoke_dir/run.log" 2>&1 || run_exit=$?
timeout 60s bd show "$child" --json > "$smoke_dir/child.json" || true
if [[ $run_exit != 0 ]]; then
  reason="simmer child exited $run_exit; see run.log"
  exit "$run_exit"
fi
reason='hello.txt is missing from main or has the wrong contents'
git show main:hello.txt > "$smoke_dir/hello-main.txt"
printf 'simmer smoke ok\n' > "$smoke_dir/expected.txt"
cmp -s "$smoke_dir/expected.txt" "$smoke_dir/hello-main.txt"
grep -qx 'simmer smoke ok' hello.txt
reason='child issue is not closed'
timeout 60s bd show "$child" --json > "$smoke_dir/child.json"
bun -e 'const issues = await Bun.file(process.argv[1]).json(); if (issues[0]?.status !== "closed") process.exit(1)' "$smoke_dir/child.json"
passed=true

import { flag, type RunOptions, record, runProcess, usage, workerPrompt } from './process'

export function run(options: RunOptions) {
  if (!Bun.which(options.binary, { PATH: options.env?.PATH ?? process.env.PATH })) {
    return Promise.reject(new Error(`spawn ${options.binary} ENOENT`))
  }
  return runProcess(
    [
      'bash',
      '-c',
      `set -o pipefail
scrub=$(command -v secret-scrub || true)
if [[ -z "$scrub" ]]; then scrub="$HOME/.local/share/secret-scrub/secret-scrub"; fi
if [[ -x "$scrub" ]] && "$scrub" check >/dev/null 2>&1; then
  "$@" 2>&1 | "$scrub" stream
elif [[ "\${SIMMER_ALLOW_UNFILTERED:-}" == 1 ]]; then
  echo 'WARNING: SIMMER_ALLOW_UNFILTERED=1. Codex output has no secret filter.' >&2
  exec "$@"
else
  echo 'Codex requires secret-scrub and a readable index. Install secret-scrub before starting this lane.' >&2
  exit 78
fi`,
      'simmer-codex',
      options.binary,
      'exec',
      '--json',
      // The secret-scrub PostToolUse hook in ~/.codex/hooks.json must run. An unattended worker
      // cannot answer /hooks, and an untrusted hook is skipped, which passes secrets to the model.
      '--dangerously-bypass-hook-trust',
      // workspace-write keeps every .git path read-only, even with --add-dir, so a worker in a
      // linked worktree could not commit. Claude and Pi workers run unsandboxed too.
      '-s',
      'danger-full-access',
      '-C',
      options.cwd,
      ...flag('-m', options.model),
      // Codex parses -c values as TOML; a JSON string is a valid TOML basic string.
      ...flag('-c', options.effort && `model_reasoning_effort=${JSON.stringify(options.effort)}`),
      workerPrompt(options)
    ],
    options,
    (event) => {
      if (event.type === 'turn.completed') {
        const tokens = record(event.usage)
        const cached = tokens.cached_input_tokens ?? 0
        // Codex counts cached input inside input_tokens; Usage.inputTokens is uncached only.
        const uncached =
          typeof tokens.input_tokens === 'number' && typeof cached === 'number'
            ? tokens.input_tokens - cached
            : tokens.input_tokens
        return { usage: usage(uncached, tokens.output_tokens, cached), usageKey: 'total' }
      }
      const item = record(event.item)
      return event.type === 'item.completed' &&
        item.type === 'agent_message' &&
        typeof item.text === 'string'
        ? { finalMessage: item.text }
        : {}
    },
    'inherit'
  )
}

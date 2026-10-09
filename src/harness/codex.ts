import { flag, type RunOptions, record, runProcess, usage, workerPrompt } from './process'

export function run(options: RunOptions) {
  return runProcess(
    [
      options.binary,
      'exec',
      '--json',
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
    }
  )
}

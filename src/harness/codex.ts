import { type RunOptions, record, rolePrompt, runProcess, usage } from './process'

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
      rolePrompt(options.prompt, options.models)
    ],
    options,
    (event) => {
      if (event.type === 'turn.completed') {
        const tokens = record(event.usage)
        return { usage: usage(tokens.input_tokens, tokens.output_tokens), usageKey: 'total' }
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

import { type RunOptions, rolePrompt, runProcess } from './process'

export function run(options: RunOptions) {
  return runProcess(
    [options.binary, '-p', rolePrompt(options.prompt, options.models), '--output-format', 'stream-json'],
    options,
    (event) =>
      event.role === 'assistant' && typeof event.content === 'string'
        ? { finalMessage: event.content }
        : {}
  )
}

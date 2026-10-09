import { flag, type RunOptions, record, runProcess, usage, workerPrompt } from './process'

export function run(options: RunOptions) {
  let message = ''
  return runProcess(
    [
      options.binary,
      '-p',
      workerPrompt(options),
      ...flag('--model', options.model),
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--sandbox=false',
      '--skip-trust'
    ],
    options,
    (event) => {
      if (event.type === 'tool_use') message = ''
      if (
        event.type === 'message' &&
        event.role === 'assistant' &&
        typeof event.content === 'string'
      ) {
        message = event.delta === true ? message + event.content : event.content
        return { finalMessage: message }
      }
      if (event.type === 'result') {
        const tokens = record(event.stats)
        const cached = tokens.cached ?? 0
        // Gemini counts cached reads inside input_tokens, like Codex.
        const uncached =
          typeof tokens.input_tokens === 'number' && typeof cached === 'number'
            ? tokens.input_tokens - cached
            : tokens.input_tokens
        return { usage: usage(uncached, tokens.output_tokens, cached), usageKey: 'total' }
      }
      return {}
    }
  )
}

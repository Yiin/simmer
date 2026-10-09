import { agents, flag, messageText, type RunOptions, record, runProcess, usage } from './process'

export function run(options: RunOptions) {
  return runProcess(
    [
      options.binary,
      '-p',
      options.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      ...flag('--model', options.model),
      ...flag('--effort', options.effort),
      ...(options.models ? ['--agents', JSON.stringify(agents(options.models))] : [])
    ],
    options,
    (event) => {
      if (event.type === 'result') {
        const tokens = record(event.usage)
        return {
          finalMessage: typeof event.result === 'string' ? event.result : undefined,
          usage: usage(
            tokens.input_tokens,
            tokens.output_tokens,
            tokens.cache_read_input_tokens,
            tokens.cache_creation_input_tokens
          ),
          usageKey: 'total'
        }
      }
      if (event.type !== 'assistant' || event.parent_tool_use_id) return {}
      const message = record(event.message)
      const tokens = record(message.usage)
      return {
        finalMessage: messageText(message.content),
        usage: usage(
          tokens.input_tokens,
          tokens.output_tokens,
          tokens.cache_read_input_tokens,
          tokens.cache_creation_input_tokens
        ),
        usageKey: typeof message.id === 'string' ? message.id : undefined
      }
    }
  )
}

import { messageText, type RunOptions, record, rolePrompt, runProcess, usage } from './process'

export function run(options: RunOptions) {
  return runProcess(
    [options.binary, '-p', '--mode', 'json', rolePrompt(options.prompt, options.models)],
    options,
    (event) => {
      const message = record(event.message)
      if (event.type !== 'message_end' || message.role !== 'assistant') return {}
      const tokens = record(message.usage)
      return {
        finalMessage: messageText(message.content),
        usage: usage(tokens.input, tokens.output)
      }
    }
  )
}

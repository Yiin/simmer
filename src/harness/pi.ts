import {
  flag,
  messageText,
  type RunOptions,
  record,
  runProcess,
  usage,
  workerPrompt
} from './process'

export function run(options: RunOptions) {
  return runProcess(
    [
      options.binary,
      '-p',
      '--mode',
      'json',
      ...flag('--model', options.model),
      ...flag('--thinking', options.effort),
      workerPrompt(options)
    ],
    options,
    (event) => {
      const message = record(event.message)
      if (event.type !== 'message_end' || message.role !== 'assistant') return {}
      const tokens = record(message.usage)
      return {
        finalMessage: messageText(message.content),
        usage: usage(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite)
      }
    }
  )
}

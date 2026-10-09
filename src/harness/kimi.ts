import { flag, type RunOptions, runProcess, workerPrompt } from './process'

export function run(options: RunOptions) {
  return runProcess(
    [
      options.binary,
      '-p',
      workerPrompt(options),
      ...flag('--model', options.model),
      '--output-format',
      'stream-json'
    ],
    options,
    (event) =>
      event.role === 'assistant' && typeof event.content === 'string'
        ? { finalMessage: event.content }
        : {}
  )
}

import { type RunOptions, record, rolePrompt, runProcess, usage } from './process'

export function run(options: RunOptions) {
  let messageId: string | undefined
  const textParts = new Map<string, string>()
  return runProcess(
    [
      options.binary,
      'run',
      '--format',
      'json',
      '--auto',
      '--agent',
      'build',
      '--dir',
      options.cwd,
      rolePrompt(options.prompt, options.models)
    ],
    { ...options, env: { ...options.env, OPENCODE_PERMISSION: '{"*":"allow"}' } },
    (event) => {
      const part = record(event.part)
      if (
        event.type === 'text' &&
        typeof part.text === 'string' &&
        typeof part.id === 'string' &&
        typeof part.messageID === 'string'
      ) {
        if (part.messageID !== messageId) {
          messageId = part.messageID
          textParts.clear()
        }
        textParts.set(part.id, part.text)
        return { finalMessage: [...textParts.values()].join('') }
      }
      if (event.type !== 'step_finish') return {}
      const tokens = record(part.tokens)
      const cache = record(tokens.cache)
      const reported = usage(tokens.input, tokens.output, cache.read, cache.write)
      const reasoning = tokens.reasoning ?? 0
      if (
        !reported ||
        typeof reasoning !== 'number' ||
        !Number.isFinite(reasoning) ||
        reasoning < 0
      ) {
        return {}
      }
      // OpenCode reports reasoning separately from output; both count as generated tokens.
      reported.outputTokens += reasoning
      return {
        usage: reported,
        usageKey: typeof part.id === 'string' ? part.id : undefined
      }
    }
  )
}

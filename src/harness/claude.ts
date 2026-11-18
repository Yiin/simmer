import {
  agents,
  contextSize,
  flag,
  messageText,
  type RunOptions,
  record,
  runProcess,
  usage
} from './process'

// Prints the relay file once, so Claude Code hands its JSON ({"decision":"block","reason":...})
// to the model after the tool call that just ended. The file moves aside, so it fires once.
// The hook adds to the user's hooks; it does not replace them.
const relayHook = `f="\${SIMMER_RELAY_FILE:-}"; if [ -n "$f" ] && [ -f "$f" ] && mv -f "$f" "$f.sent"; then cat "$f.sent"; fi; exit 0`

export function relaySettings(): string {
  return JSON.stringify({
    hooks: { PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: relayHook }] }] }
  })
}

export function run(options: RunOptions) {
  const relay = options.relaySignalFile
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
      ...(options.models ? ['--agents', JSON.stringify(agents(options.models))] : []),
      ...(relay ? ['--settings', relaySettings()] : [])
    ],
    relay ? { ...options, env: { ...options.env, SIMMER_RELAY_FILE: relay } } : options,
    (event) => {
      if (event.type === 'result') {
        const tokens = record(event.usage)
        return {
          hookStopped: event.terminal_reason === 'hook_stopped',
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
      if (event.parent_tool_use_id) return {}
      if (event.type === 'user') {
        const content = record(event.message).content
        const toolResult =
          Array.isArray(content) && content.some((block) => record(block).type === 'tool_result')
        return toolResult ? { toolResult } : {}
      }
      if (event.type !== 'assistant') return {}
      const message = record(event.message)
      const tokens = record(message.usage)
      const reported = usage(
        tokens.input_tokens,
        tokens.output_tokens,
        tokens.cache_read_input_tokens,
        tokens.cache_creation_input_tokens
      )
      // Claude Code repeats one API message per content block, with the same id and usage.
      const id = typeof message.id === 'string' ? message.id : undefined
      return {
        finalMessage: messageText(message.content),
        usage: reported,
        usageKey: id,
        context: id ? contextSize(reported) : undefined
      }
    }
  )
}

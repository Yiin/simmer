import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeHooks, STOP_MARKER } from './agy-hook'
import {
  contextSize,
  type HarnessResult,
  type RunOptions,
  record,
  runProcess,
  type StreamEvent,
  usage,
  workerPrompt
} from './process'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const HOOK_STOPPED_EXIT = 75
const NO_GUARDS_EXIT = 78

// agy encodes effort in the model name (gemini-4-neon-high) and rejects --effort that disagrees with
// that suffix. --effort wins: simmer swaps the suffix. A model without a suffix gets agy's --effort.
export function agyModelArgs(model: string | undefined, effort: string | undefined): string[] {
  if (effort === undefined) return model === undefined ? [] : ['--model', model]
  if (model === undefined) return ['--effort', effort]
  const suffix = EFFORTS.find((level) => model.endsWith(`-${level}`))
  if (suffix === undefined) return ['--model', model, '--effort', effort]
  return ['--model', `${model.slice(0, -suffix.length)}${effort}`]
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// The per-run hooks.json. agy loads <dir>/.agents/hooks.json for a directory passed with --add-dir.
export function agyHooks(hookScript: string, stateDir: string) {
  const command = (event: string) =>
    [process.execPath, hookScript, event, stateDir].map(quote).join(' ')
  return {
    'simmer-guard': {
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: command('pre-tool'), timeout: 60 }] }
      ],
      PreInvocation: [{ type: 'command', command: command('pre-invocation'), timeout: 120 }]
    }
  }
}

// Parses one agy stream-json event. text collects the deltas of the agent response being written.
export function agyEvent(event: Record<string, unknown>, state: { text: string; step: unknown }) {
  if (event.event === 'result') {
    const result = record(event.result)
    const tokens = record(result.usage)
    const total = agyUsage(tokens)
    return {
      finalMessage:
        typeof result.response === 'string' && result.response !== '' ? result.response : undefined,
      failed: result.status !== 'SUCCESS',
      error: typeof result.error === 'string' ? result.error : undefined,
      ...(total ? { usage: total, usageKey: 'total' } : {})
    } satisfies StreamEvent & { failed: boolean; error?: string }
  }
  if (event.event !== 'step_update') return {}
  const step = record(event.step_update)
  if (step.step_type === 'tool' || step.step_type === 'subagent') {
    return step.state === 'DONE' || step.state === 'ERROR' ? { toolResult: true } : {}
  }
  if (step.step_type !== 'agent_response') return {}
  if (step.step_index !== state.step) {
    state.step = step.step_index
    state.text = ''
  }
  if (typeof step.text_delta === 'string') state.text += step.text_delta
  if (step.state !== 'DONE') return {}
  const reported = agyUsage(record(step.usage))
  const finalMessage = state.text.trim() === '' ? undefined : state.text
  if (!reported) return { finalMessage }
  return {
    finalMessage,
    usage: reported,
    usageKey: `step-${String(step.step_index)}`,
    context: contextSize(reported)
  } satisfies StreamEvent
}

// agy reports input_tokens without the cache read, like Claude, and thinking apart from output.
function agyUsage(tokens: Record<string, unknown>) {
  const value = usage(tokens.input_tokens, tokens.output_tokens, tokens.cache_read_tokens)
  if (!value) return undefined
  return typeof tokens.thinking_tokens === 'number'
    ? { ...value, thinkingTokens: tokens.thinking_tokens }
    : value
}

export async function run(options: RunOptions): Promise<HarnessResult> {
  const hooks = await claudeHooks(options.env)
  if (!hooks.PreToolUse.length && !hooks.PostToolUse.length) {
    const allow =
      (options.env?.SIMMER_ALLOW_UNFILTERED ?? process.env.SIMMER_ALLOW_UNFILTERED) === '1'
    if (!allow) {
      process.stderr.write(
        `simmer agy: no PreToolUse or PostToolUse hooks in ${hooks.file}. agy runs the Claude Code guard hooks (secret-scrub, no-heavy-jobs); install them, or set SIMMER_ALLOW_UNFILTERED=1.\n`
      )
      return {
        exitCode: NO_GUARDS_EXIT,
        finalMessage: '',
        usage: undefined,
        killedByWatchdog: false
      }
    }
    process.stderr.write(
      'simmer agy: WARNING: SIMMER_ALLOW_UNFILTERED=1. agy runs with no guard hooks.\n'
    )
  }
  const hookDir = await mkdtemp(join(tmpdir(), 'simmer-agy-'))
  try {
    const stateDir = join(hookDir, 'state')
    await mkdir(join(hookDir, '.agents'))
    await mkdir(stateDir)
    const hookScript = join(import.meta.dir, 'agy-hook.ts')
    await writeFile(
      join(hookDir, '.agents', 'hooks.json'),
      `${JSON.stringify(agyHooks(hookScript, stateDir), null, 2)}\n`
    )
    await chmod(join(hookDir, '.agents', 'hooks.json'), 0o444)
    const state = { text: '', step: undefined as unknown }
    let failed = false
    // agy gives hooks the hooks folder as cwd; Claude hooks expect the folder the agent works in.
    const env = {
      ...options.env,
      SIMMER_AGY_CWD: options.cwd,
      ...(options.relaySignalFile ? { SIMMER_RELAY_FILE: options.relaySignalFile } : {})
    }
    const result = await runProcess(
      [
        options.binary,
        '-p',
        workerPrompt(options),
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
        '--add-dir',
        hookDir,
        ...agyModelArgs(options.model, options.effort)
      ],
      { ...options, env },
      (event) => {
        const parsed = agyEvent(event, state)
        if ('failed' in parsed && parsed.failed) {
          failed = true
          if (parsed.error) process.stderr.write(`simmer agy: ${parsed.error}\n`)
        }
        return parsed
      },
      'inherit'
    )
    if (existsSync(join(stateDir, STOP_MARKER))) {
      process.stderr.write(
        'simmer agy: a guard hook stopped the run before the next model call (a secret reached a tool result)\n'
      )
      return { ...result, exitCode: HOOK_STOPPED_EXIT }
    }
    return failed && result.exitCode === 0 ? { ...result, exitCode: 1 } : result
  } finally {
    await rm(hookDir, { recursive: true, force: true })
  }
}

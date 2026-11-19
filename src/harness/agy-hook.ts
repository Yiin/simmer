// agy hook command (simmer's agy harness writes it into a per-run hooks.json).
// agy has no Claude Code hooks, so this runs the PreToolUse and PostToolUse hooks of
// ~/.claude/settings.json (secret-scrub, no-heavy-jobs) on agy's events:
//   pre-tool        agy PreToolUse. Claude PreToolUse hooks see the call as a Claude tool call.
//                   A block becomes agy's deny. Subagent tool calls reach this hook too.
//   pre-invocation  agy PreInvocation, before each model call. agy's PostToolUse cannot see or
//                   change a tool's output, so the Claude PostToolUse hooks read the steps added to
//                   agy's transcript since the last model call. A hook that would rewrite or stop
//                   the output stops the run before the model reads it. Then the relay message
//                   (SIMMER_RELAY_FILE) goes to the model as a system message.
// Usage: bun agy-hook.ts pre-tool|pre-invocation <state-dir>, hook JSON on stdin, answer on stdout.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STOP_MARKER = 'stopped'

// args: Claude Code runs the command with these arguments and no shell. blockOnFailure: onFailure "block".
type HookCommand = { command: string; args?: string[]; timeout: number; blockOnFailure: boolean }
type HookGroup = { matcher: string; commands: HookCommand[] }
export type ClaudeHooks = { file: string; PreToolUse: HookGroup[]; PostToolUse: HookGroup[] }

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function claudeSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.SIMMER_CLAUDE_SETTINGS ??
    join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), 'settings.json')
  )
}

function groups(value: unknown): HookGroup[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const group = record(entry)
    const commands = (Array.isArray(group.hooks) ? group.hooks : []).flatMap((hook) => {
      const { command, args, timeout, type, onFailure } = record(hook)
      if (typeof command !== 'string' || (type !== undefined && type !== 'command')) return []
      const argv = Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : undefined
      return [
        {
          command,
          ...(argv ? { args: argv } : {}),
          timeout: typeof timeout === 'number' ? timeout : 60,
          blockOnFailure: onFailure === 'block'
        }
      ]
    })
    const matcher = typeof group.matcher === 'string' ? group.matcher : ''
    return commands.length ? [{ matcher, commands }] : []
  })
}

export async function claudeHooks(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeHooks> {
  const file = claudeSettingsFile({ ...process.env, ...env })
  let settings: Record<string, unknown> = {}
  try {
    settings = record(JSON.parse(await readFile(file, 'utf8')))
  } catch {}
  const hooks = record(settings.hooks)
  return { file, PreToolUse: groups(hooks.PreToolUse), PostToolUse: groups(hooks.PostToolUse) }
}

function matches(matcher: string, tool: string): boolean {
  if (matcher === '' || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool)
  } catch {
    return matcher === tool
  }
}

// An agy tool call as the Claude tool call that does the same thing, so Claude hooks know it.
export function claudeTool(toolCall: Record<string, unknown>): {
  tool_name: string
  tool_input: Record<string, unknown>
} {
  const name = typeof toolCall.name === 'string' ? toolCall.name : ''
  const args = record(toolCall.args)
  const path = [args.Path, args.AbsolutePath, args.TargetFile, args.FilePath, args.File].find(
    (value) => typeof value === 'string'
  )
  switch (name) {
    case 'run_command':
      return { tool_name: 'Bash', tool_input: { command: args.CommandLine ?? '', cwd: args.Cwd } }
    case 'send_command_input':
      return { tool_name: 'Bash', tool_input: { command: args.Input ?? '' } }
    case 'read_file':
    case 'view_file':
      return { tool_name: 'Read', tool_input: { file_path: path ?? '' } }
    case 'write_file':
    case 'write_to_file':
      return {
        tool_name: 'Write',
        tool_input: { file_path: path ?? '', content: args.CodeContent }
      }
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'sed_file':
      return { tool_name: 'Edit', tool_input: { file_path: path ?? '' } }
    default:
      return { tool_name: name, tool_input: { ...args, ...(path ? { file_path: path } : {}) } }
  }
}

type Verdict = { block: boolean; rewrite: boolean; reason: string }

// What one Claude hook answered: exit 2, a deny or block decision, continue:false, or new output.
export function runClaudeHook(hook: HookCommand, input: Record<string, unknown>): Verdict {
  const [file, argv] = hook.args ? [hook.command, hook.args] : ['sh', ['-c', hook.command]]
  const result = spawnSync(file, argv, {
    cwd: typeof input.cwd === 'string' && existsSync(input.cwd) ? input.cwd : undefined,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: hook.timeout * 1000,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error || result.status === null) {
    return { block: true, rewrite: false, reason: `hook ${hook.command} did not finish` }
  }
  if (result.status === 2) return { block: true, rewrite: false, reason: result.stderr.trim() }
  if (result.status !== 0 && hook.blockOnFailure) {
    return {
      block: true,
      rewrite: false,
      reason: `hook ${hook.command} failed (exit ${result.status})`
    }
  }
  let answer: Record<string, unknown> = {}
  try {
    answer = record(JSON.parse(result.stdout))
  } catch {}
  const specific = record(answer.hookSpecificOutput)
  const reason = [specific.permissionDecisionReason, answer.reason, answer.stopReason].find(
    (value) => typeof value === 'string'
  ) as string | undefined
  return {
    block:
      specific.permissionDecision === 'deny' ||
      answer.decision === 'block' ||
      answer.continue === false,
    rewrite: specific.updatedToolOutput !== undefined,
    reason: reason ?? `blocked by ${hook.command}`
  }
}

function common(payload: Record<string, unknown>) {
  const cwd = process.env.SIMMER_AGY_CWD ?? payload.cwd
  return {
    session_id: typeof payload.conversationId === 'string' ? payload.conversationId : 'agy',
    transcript_path: '',
    cwd: typeof cwd === 'string' ? cwd : process.cwd(),
    permission_mode: 'bypassPermissions'
  }
}

export function preTool(payload: Record<string, unknown>, hooks: ClaudeHooks) {
  const tool = claudeTool(record(payload.toolCall))
  const input = { ...common(payload), hook_event_name: 'PreToolUse', ...tool }
  for (const group of hooks.PreToolUse) {
    if (!matches(group.matcher, tool.tool_name)) continue
    for (const hook of group.commands) {
      const verdict = runClaudeHook(hook, input)
      if (verdict.block) return { decision: 'deny', reason: verdict.reason }
    }
  }
  // agy denies a tool when the answer has no decision, so an empty answer is not neutral.
  return { decision: 'allow' }
}

// Steps added to the transcript since the last call, as text. Only whole lines count.
function newSteps(transcript: string, offsetFile: string): { texts: string[]; offset: number } {
  const start = existsSync(offsetFile) ? Number(readFileSync(offsetFile, 'utf8')) || 0 : 0
  const data = readFileSync(transcript)
  const end = data.lastIndexOf(10) + 1
  if (end <= start) return { texts: [], offset: start }
  const texts = data
    .subarray(start, end)
    .toString('utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const step = record(JSON.parse(line))
        if (step.type === 'USER_INPUT') return []
        const text = [step.content, step.tool_calls, step.error]
          .filter((value) => value !== undefined)
          .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
          .join('\n')
        return text === '' ? [] : [text]
      } catch {
        return []
      }
    })
  return { texts, offset: end }
}

function stop(stateDir: string, reason: string) {
  writeFileSync(join(stateDir, STOP_MARKER), `${reason}\n`)
  return {
    injectSteps: [{ errorMessage: { userMessage: `simmer agy guard: ${reason}` } }],
    terminationBehavior: 'terminate'
  }
}

export function preInvocation(
  payload: Record<string, unknown>,
  hooks: ClaudeHooks,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env
) {
  const transcript = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : ''
  if (hooks.PostToolUse.length && transcript !== '' && existsSync(transcript)) {
    const id = String(payload.conversationId ?? 'agy').replace(/[^A-Za-z0-9-]/g, '_')
    const offsetFile = join(stateDir, `offset-${id}`)
    const { texts, offset } = newSteps(transcript, offsetFile)
    for (const text of texts) {
      const input = {
        ...common(payload),
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: '' },
        tool_response: { stdout: text, stderr: '', interrupted: false }
      }
      // Run every PostToolUse hook whatever its matcher: the step's tool is not known here.
      for (const hook of hooks.PostToolUse.flatMap((group) => group.commands)) {
        const verdict = runClaudeHook(hook, input)
        if (verdict.block || verdict.rewrite) {
          return stop(
            stateDir,
            verdict.rewrite
              ? `${hook.command} found text in a tool result that it would remove; agy cannot remove it, so the run stops before the model reads it`
              : verdict.reason
          )
        }
      }
    }
    writeFileSync(offsetFile, String(offset))
  }
  const relay = env.SIMMER_RELAY_FILE
  if (relay && existsSync(relay)) {
    try {
      renameSync(relay, `${relay}.sent`)
      const reason = record(JSON.parse(readFileSync(`${relay}.sent`, 'utf8'))).reason
      if (typeof reason === 'string') {
        return { injectSteps: [{ systemMessage: { systemMessage: reason } }] }
      }
    } catch {}
  }
  return {}
}

async function main() {
  const [event, stateDir] = process.argv.slice(2)
  let payload: Record<string, unknown> = {}
  try {
    payload = record(JSON.parse(await Bun.stdin.text()))
  } catch {}
  try {
    const hooks = await claudeHooks()
    if (event === 'pre-tool') return preTool(payload, hooks)
    if (event === 'pre-invocation' && stateDir) return preInvocation(payload, hooks, stateDir)
    throw new Error(`unknown hook event ${event}`)
  } catch (error) {
    // Fail closed: a guard that cannot run blocks the tool or stops the run.
    const reason = `agy guard hook failed: ${error instanceof Error ? error.message : String(error)}`
    if (event === 'pre-tool') return { decision: 'deny', reason }
    return stateDir ? stop(stateDir, reason) : { terminationBehavior: 'terminate' }
  }
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(await main())}\n`)

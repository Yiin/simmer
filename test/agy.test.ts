import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agyHooks, agyModelArgs, run } from '../src/harness/agy'
import { claudeTool, runClaudeHook } from '../src/harness/agy-hook'

// A real agy 1.5.12 stream (gemini-3.8-flash-low): a shell command, a subagent, two replies.
// The tool list is trimmed and paths are scrubbed.
const fixture = readFileSync(new URL('./fixtures/agy-stream.jsonl', import.meta.url), 'utf8')
const hookScript = join(import.meta.dir, '..', 'src/harness/agy-hook.ts')
let directory: string
let settings: string

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer-agy-test-')
  settings = join(directory, 'claude-settings.json')
  // Stand-ins for the Claude Code guard hooks: a heavy-jobs guard on Bash (exit 2), a secret
  // filter on every tool that denies reading .env and rewrites output holding the test canary.
  // Like the real secret-scrub, the filter does nothing unless its args ("hook") reach it.
  writeFileSync(
    join(directory, 'heavy-guard'),
    `#!/bin/sh\ngrep -q 'bun test' && { echo 'heavy job: use a fleet host' >&2; exit 2; }\nexit 0\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    join(directory, 'secret-filter'),
    `#!/bin/sh
[ "$1" = hook ] || exit 0
input=$(cat)
case "$input" in
  *PostToolUse*TEST-CANARY*) echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"[removed]"}}' ;;
  *PreToolUse*.env*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"secret file"}}' ;;
esac
pwd > "${directory}/hook-cwd.txt"
exit 0
`,
    { mode: 0o755 }
  )
  const filterHook = {
    type: 'command',
    command: join(directory, 'secret-filter'),
    args: ['hook'],
    onFailure: 'block'
  }
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [filterHook] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: join(directory, 'heavy-guard') }] }
        ],
        PostToolUse: [{ matcher: '*', hooks: [filterHook] }]
      }
    })
  )
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

// A fake agy: records its arguments and the hooks.json it was given, then runs BODY.
function fakeAgy(body: string) {
  const binary = join(directory, 'agy')
  writeFileSync(
    binary,
    `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const hookDir = args[args.indexOf('--add-dir') + 1]
writeFileSync('invocation.json', JSON.stringify({
  arguments: args,
  hooks: existsSync(hookDir + '/.agents/hooks.json') ? readFileSync(hookDir + '/.agents/hooks.json', 'utf8') : null,
  cwdEnv: process.env.SIMMER_AGY_CWD ?? null
}))
${body}
`,
    { mode: 0o755 }
  )
  return binary
}

function runAgy(binary: string, extra: Partial<Parameters<typeof run>[0]> = {}) {
  return run({
    prompt: 'Do the task.',
    cwd: directory,
    binary,
    watchdogMinutes: 1,
    watchdogIntervalMs: 20,
    env: { SIMMER_CLAUDE_SETTINGS: settings },
    ...extra
  })
}

function invocation(): { arguments: string[]; hooks: string | null; cwdEnv: string | null } {
  return JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8'))
}

// Runs one command from the per-run hooks.json the way agy does: sh, payload on stdin.
function runHook(command: string, payload: Record<string, unknown>, env: Record<string, string>) {
  // /bin/sh, so a test that breaks PATH breaks only the hooks this command starts.
  const result = Bun.spawnSync(['/bin/sh', '-c', command], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { PATH: process.env.PATH ?? '', HOME: directory, SIMMER_CLAUDE_SETTINGS: settings, ...env }
  })
  return JSON.parse(result.stdout.toString())
}

test('agy runs headless with a per-run hooks folder and parses the live stream fixture', async () => {
  const binary = fakeAgy(`process.stdout.write(${JSON.stringify(fixture)})`)
  const result = await runAgy(binary, { model: 'gemini-4-neon-high', effort: 'low' })
  expect(result).toEqual({
    exitCode: 0,
    finalMessage:
      'Completed both shell commands successfully, producing `42mainz` in the main session and `56subz` from the subagent.\nBoth commands executed successfully, producing `42mainz` and `56subz`.\n',
    usage: {
      inputTokens: 15534,
      outputTokens: 141,
      cacheReadTokens: 20896,
      cacheWriteTokens: 0,
      thinkingTokens: 0
    },
    turns: 4,
    peakContext: 9427,
    killedByWatchdog: false
  })
  const { arguments: args, hooks, cwdEnv } = invocation()
  const hookDir = args[args.indexOf('--add-dir') + 1] ?? ''
  expect(args).toEqual([
    '-p',
    'Do the task.',
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--add-dir',
    hookDir,
    '--model',
    'gemini-4-neon-low'
  ])
  expect(cwdEnv).toBe(directory)
  expect(JSON.parse(hooks ?? '{}')).toEqual(agyHooks(hookScript, join(hookDir, 'state')))
  // The hooks folder lives only as long as the run.
  expect(existsSync(hookDir)).toBe(false)
})

test('--effort wins over the effort suffix of an agy model name', () => {
  expect(agyModelArgs(undefined, undefined)).toEqual([])
  expect(agyModelArgs('gemini-4-neon-high', undefined)).toEqual(['--model', 'gemini-4-neon-high'])
  expect(agyModelArgs('gemini-4-neon-high', 'xhigh')).toEqual(['--model', 'gemini-4-neon-xhigh'])
  expect(agyModelArgs('gemini-3.8-flash-medium', 'low')).toEqual([
    '--model',
    'gemini-3.8-flash-low'
  ])
  expect(agyModelArgs('claude-sonnet', 'high')).toEqual([
    '--model',
    'claude-sonnet',
    '--effort',
    'high'
  ])
  expect(agyModelArgs(undefined, 'medium')).toEqual(['--effort', 'medium'])
})

test('agy refuses to start without guard hooks unless the run allows it', async () => {
  const binary = fakeAgy(`process.stdout.write(${JSON.stringify(fixture)})`)
  const empty = join(directory, 'empty-settings.json')
  writeFileSync(empty, '{"hooks":{}}')
  const refused = await runAgy(binary, { env: { SIMMER_CLAUDE_SETTINGS: empty } })
  expect(refused.exitCode).toBe(78)
  expect(existsSync(join(directory, 'invocation.json'))).toBe(false)
  const allowed = await runAgy(binary, {
    env: { SIMMER_CLAUDE_SETTINGS: empty, SIMMER_ALLOW_UNFILTERED: '1' }
  })
  expect(allowed.exitCode).toBe(0)
})

test('agy exit codes: an ERROR result fails, a guard stop is 75, a crash keeps its code', async () => {
  const failed = fakeAgy(
    `process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'quota', response: '' } }) + '\\n')`
  )
  expect((await runAgy(failed)).exitCode).toBe(1)
  const stopped = fakeAgy(
    `writeFileSync(hookDir + '/state/stopped', 'secret\\n')
process.stdout.write(${JSON.stringify(fixture)})`
  )
  expect((await runAgy(stopped)).exitCode).toBe(75)
  const crashed = fakeAgy('process.exit(3)')
  expect((await runAgy(crashed)).exitCode).toBe(3)
})

test('the PreToolUse bridge runs the Claude guard hooks on agy tool calls', () => {
  const state = join(directory, 'state')
  mkdirSync(state)
  const worktree = join(directory, 'worktree')
  mkdirSync(worktree)
  const command = agyHooks(hookScript, state)['simmer-guard'].PreToolUse[0]?.hooks[0]?.command ?? ''
  const call = (name: string, args: Record<string, unknown>) =>
    runHook(
      command,
      { hookEventName: 'PreToolUse', cwd: '/tmp', toolCall: { name, args } },
      { SIMMER_AGY_CWD: worktree }
    )
  expect(call('run_command', { CommandLine: 'echo hi' })).toEqual({ decision: 'allow' })
  // Claude hooks run in the agent's folder, not in agy's hooks folder.
  expect(readFileSync(join(directory, 'hook-cwd.txt'), 'utf8').trim()).toBe(worktree)
  expect(call('run_command', { CommandLine: 'bun test' })).toEqual({
    decision: 'deny',
    reason: 'heavy job: use a fleet host'
  })
  expect(call('view_file', { AbsolutePath: '/repo/.env' })).toEqual({
    decision: 'deny',
    reason: 'secret file'
  })
  // The Bash-only guard does not see file tools.
  expect(call('view_file', { AbsolutePath: '/repo/bun test.md' })).toEqual({ decision: 'allow' })
  // A guard that cannot run blocks the tool.
  const broken = runHook(
    command,
    { toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } } },
    { SIMMER_CLAUDE_SETTINGS: settings, SIMMER_AGY_CWD: worktree, PATH: '/nonexistent' }
  )
  expect(broken.decision).toBe('deny')
})

test('the PreInvocation bridge stops the run before the model reads a secret, and relays once', () => {
  const state = join(directory, 'state')
  mkdirSync(state)
  const command = agyHooks(hookScript, state)['simmer-guard'].PreInvocation[0]?.command ?? ''
  const transcript = join(directory, 'transcript.jsonl')
  const relay = join(directory, 'relay.json')
  const step = (index: number, type: string, content: string) =>
    `${JSON.stringify({ step_index: String(index), type, content })}\n`
  const invoke = () =>
    runHook(
      command,
      { hookEventName: 'PreInvocation', conversationId: 'c-1', transcriptPath: transcript },
      { SIMMER_RELAY_FILE: relay }
    )
  writeFileSync(
    transcript,
    step(0, 'USER_INPUT', 'brief with TEST-CANARY') + step(1, 'GENERIC', 'ok')
  )
  expect(invoke()).toEqual({})
  expect(readFileSync(join(state, 'offset-c-1'), 'utf8')).not.toBe('0')

  writeFileSync(relay, JSON.stringify({ decision: 'block', reason: 'SIMMER RELAY: hand off' }))
  expect(invoke()).toEqual({
    injectSteps: [{ systemMessage: { systemMessage: 'SIMMER RELAY: hand off' } }]
  })
  expect(invoke()).toEqual({})

  writeFileSync(
    transcript,
    `${readFileSync(transcript, 'utf8')}${step(2, 'GENERIC', 'TEST-CANARY')}`
  )
  const stopped = invoke()
  expect(stopped.terminationBehavior).toBe('terminate')
  expect(existsSync(join(state, 'stopped'))).toBe(true)
})

test('agy tool calls map to the Claude tools the guard hooks know', () => {
  expect(claudeTool({ name: 'run_command', args: { CommandLine: 'ls', Cwd: '/w' } })).toEqual({
    tool_name: 'Bash',
    tool_input: { command: 'ls', cwd: '/w' }
  })
  expect(claudeTool({ name: 'view_file', args: { AbsolutePath: '/w/a' } })).toEqual({
    tool_name: 'Read',
    tool_input: { file_path: '/w/a' }
  })
  expect(
    claudeTool({ name: 'write_to_file', args: { TargetFile: '/w/b', CodeContent: 'x' } })
  ).toEqual({ tool_name: 'Write', tool_input: { file_path: '/w/b', content: 'x' } })
  expect(claudeTool({ name: 'edit_file', args: { Path: '/w/c' } })).toEqual({
    tool_name: 'Edit',
    tool_input: { file_path: '/w/c' }
  })
  expect(claudeTool({ name: 'grep_search', args: { Query: 'x' } })).toEqual({
    tool_name: 'grep_search',
    tool_input: { Query: 'x' }
  })
})

test('a hook with onFailure block blocks the tool when it fails', () => {
  const failing = { command: 'exit 1', timeout: 5, blockOnFailure: true }
  expect(runClaudeHook(failing, {}).block).toBe(true)
  expect(runClaudeHook({ ...failing, blockOnFailure: false }, {}).block).toBe(false)
  expect(runClaudeHook({ command: 'true', timeout: 5, blockOnFailure: true }, {}).block).toBe(false)
})

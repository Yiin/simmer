import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../src/config'
import { type LaneUsage, parseLaneArgs, RELAY_GRACE_TURNS, usageSummary } from '../src/lane'

const cliPath = join(import.meta.dir, '..', 'src/cli.ts')
let directory: string
let worktree: string
let brief: string

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer-lane-')
  worktree = join(directory, 'worktree')
  mkdirSync(worktree)
  mkdirSync(join(directory, 'bin'))
  brief = join(directory, 'brief.md')
  writeFileSync(brief, 'Do the task. Keep "quotes" and $variables literal.\nSecond line.')
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function fake(name: string, body: string) {
  writeFileSync(
    join(directory, 'bin', name),
    `#!${process.execPath}
import { writeFileSync } from 'node:fs'
writeFileSync('invocation.json', JSON.stringify(process.argv.slice(2)))
${body}
`,
    { mode: 0o755 }
  )
}

function lane(args: string[]) {
  const result = Bun.spawnSync([process.execPath, cliPath, 'lane', ...args], {
    cwd: directory,
    env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}` }
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  }
}

function invocation(): string[] {
  return JSON.parse(readFileSync(join(worktree, 'invocation.json'), 'utf8'))
}

const claudeResult = (text: string) =>
  `process.stdout.write(${JSON.stringify(
    `${JSON.stringify({
      type: 'result',
      result: text,
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 7 }
    })}\n`
  )})`

test('parses defaults', () => {
  expect(parseLaneArgs(['brief.md', '--worktree', 'wt'])).toEqual({
    brief: 'brief.md',
    worktree: 'wt',
    harness: undefined,
    model: undefined,
    effort: undefined,
    out: undefined,
    usageOut: undefined,
    contextCeiling: undefined,
    maxRelays: 3,
    watchdogMinutes: 45,
    timeoutMinutes: 720,
    json: false
  })
})

test('parses every flag', () => {
  expect(
    parseLaneArgs([
      'brief.md',
      '--worktree',
      'wt',
      '--harness',
      'codex',
      '--model',
      'gpt-5.5',
      '--effort',
      'high',
      '--out',
      'out.txt',
      '--usage-out',
      'usage.json',
      '--context-ceiling',
      '150000',
      '--max-relays',
      '0',
      '--watchdog-minutes',
      '10',
      '--timeout-minutes',
      '0.5',
      '--json'
    ])
  ).toEqual({
    brief: 'brief.md',
    worktree: 'wt',
    harness: 'codex',
    model: 'gpt-5.5',
    effort: 'high',
    out: 'out.txt',
    usageOut: 'usage.json',
    contextCeiling: 150000,
    maxRelays: 0,
    watchdogMinutes: 10,
    timeoutMinutes: 0.5,
    json: true
  })
})

test('returns undefined for help', () => {
  expect(parseLaneArgs(['--help'])).toBeUndefined()
})

test('rejects bad arguments', () => {
  expect(() => parseLaneArgs(['--worktree', 'wt'])).toThrow('Usage: simmer lane')
  expect(() => parseLaneArgs(['a', 'b', '--worktree', 'wt'])).toThrow('Usage: simmer lane')
  expect(() => parseLaneArgs(['brief.md'])).toThrow('needs --worktree')
  expect(() => parseLaneArgs(['brief.md', '--worktree', 'wt', '--harness', 'x'])).toThrow(
    '--harness must be'
  )
  expect(() => parseLaneArgs(['brief.md', '--worktree', 'wt', '--model=-x'])).toThrow('--model')
  expect(() => parseLaneArgs(['brief.md', '--worktree', 'wt', '--effort', ' '])).toThrow('--effort')
  for (const minutes of ['0', '-1', 'soon', '']) {
    expect(() =>
      parseLaneArgs(['brief.md', '--worktree', 'wt', `--timeout-minutes=${minutes}`])
    ).toThrow('--timeout-minutes must be a positive number')
  }
  expect(() => parseLaneArgs(['brief.md', '--worktree', 'wt', '--bogus'])).toThrow()
  for (const tokens of ['0', '-5', '1.5', 'many', '']) {
    expect(() =>
      parseLaneArgs(['brief.md', '--worktree', 'wt', `--context-ceiling=${tokens}`])
    ).toThrow('--context-ceiling must be a whole number of at least 1')
  }
  expect(() => parseLaneArgs(['brief.md', '--worktree', 'wt', '--max-relays=-1'])).toThrow(
    '--max-relays must be a whole number of at least 0'
  )
})

test('fails clearly when the worktree does not exist', () => {
  fake('claude', claudeResult('never'))
  const result = lane([brief, '--worktree', join(directory, 'missing')])
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(
    `--worktree ${join(directory, 'missing')} is not an existing directory\n`
  )
  expect(existsSync(join(directory, 'missing'))).toBe(false)
})

test('fails clearly when the brief is missing or empty', () => {
  expect(lane([join(directory, 'none.md'), '--worktree', worktree]).stderr).toStartWith(
    `Cannot read brief ${join(directory, 'none.md')}`
  )
  writeFileSync(brief, '  \n')
  expect(lane([brief, '--worktree', worktree]).stderr).toBe(`Brief ${brief} is empty\n`)
})

const flags: Record<Harness, { model: string[]; effort: string[] }> = {
  claude: { model: ['--model', 'm1'], effort: ['--effort', 'high'] },
  codex: { model: ['-m', 'm1'], effort: ['-c', 'model_reasoning_effort="high"'] },
  pi: { model: ['--model', 'm1'], effort: ['--thinking', 'high'] },
  gemini: { model: ['--model', 'm1'], effort: [] },
  kimi: { model: ['--model', 'm1'], effort: [] },
  opencode: { model: ['--model', 'm1'], effort: ['--variant', 'high'] },
  crush: { model: ['--model', 'm1'], effort: ['--reasoning-effort', 'high'] }
}

for (const [harness, expected] of Object.entries(flags)) {
  test(`${harness} gets the raw brief, the model, and the effort`, () => {
    fake(harness, '')
    const result = lane([
      brief,
      '--worktree',
      worktree,
      '--harness',
      harness,
      '--model',
      'm1',
      '--effort',
      'high'
    ])
    const args = invocation()
    const text = readFileSync(brief, 'utf8')
    expect(args).toContain(text)
    expect(args.join('\n')).not.toContain('Cook-it stage roles')
    expect(args).not.toContain('--agents')
    const contains = (sequence: string[]) =>
      args.some((_, index) => sequence.every((value, offset) => args[index + offset] === value))
    expect(contains(expected.model)).toBe(true)
    if (expected.effort.length) {
      expect(contains(expected.effort)).toBe(true)
      expect(result.stderr).not.toContain('ignoring --effort')
    } else {
      expect(args).not.toContain('high')
      expect(result.stderr).toContain(`${harness} has no reasoning effort flag; ignoring --effort`)
    }
  })
}

test('leaves model and effort flags out when not given', () => {
  fake('codex', '')
  lane([brief, '--worktree', worktree, '--harness', 'codex'])
  expect(invocation()).toEqual([
    'exec',
    '--json',
    '--dangerously-bypass-hook-trust',
    '-s',
    'danger-full-access',
    '-C',
    worktree,
    readFileSync(brief, 'utf8')
  ])
})

test('defaults the harness from simmer.json in the worktree', () => {
  writeFileSync(join(worktree, 'simmer.json'), JSON.stringify({ harness: 'pi' }))
  fake('pi', '')
  expect(lane([brief, '--worktree', worktree]).exitCode).toBe(0)
  expect(invocation()[0]).toBe('-p')
})

test('a brief that starts with - is not read as an option', () => {
  writeFileSync(brief, '---\ntitle: lane\n---\nDo it.')
  fake('claude', claudeResult('ok'))
  lane([brief, '--worktree', worktree])
  expect(invocation()[1]).toBe('\n---\ntitle: lane\n---\nDo it.')
})

test('prints the final message, writes --out, and reports usage', () => {
  fake('claude', claudeResult('DONE'))
  const out = join(directory, 'out.txt')
  const result = lane([brief, '--worktree', worktree, '--model', 'sonnet', '--out', out])
  expect(result).toEqual({
    exitCode: 0,
    stdout: 'DONE\n',
    stderr: 'simmer lane: usage: input 5, output 2, cache read 7, cache write 0\n'
  })
  expect(readFileSync(out, 'utf8')).toBe('DONE')
})

test('--json prints one event per line', () => {
  fake('claude', claudeResult('DONE'))
  const result = lane([brief, '--worktree', worktree, '--json'])
  const lines = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(lines[0]).toEqual({
    event: 'lane-started',
    harness: 'claude',
    model: null,
    effort: null,
    worktree
  })
  expect(lines[1]).toMatchObject({
    event: 'done',
    outcome: 'passed',
    exitCode: 0,
    finalMessage: 'DONE',
    usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 0 }
  })
})

test('returns the harness exit code with a reason', () => {
  fake('claude', `${claudeResult('broke')}\nprocess.exit(3)`)
  const result = lane([brief, '--worktree', worktree])
  expect(result.exitCode).toBe(3)
  expect(result.stdout).toBe('broke\n')
  expect(result.stderr).toEndWith('simmer lane: claude exited 3\n')
})

test('the watchdog kills a silent harness', () => {
  fake('claude', 'await Bun.sleep(10000)')
  const result = lane([brief, '--worktree', worktree, '--watchdog-minutes', '0.002'])
  expect(result.exitCode).toBe(125)
  expect(result.stderr).toBe('simmer lane: watchdog killed claude after 0.002 silent minutes\n')
})

test('the overall timeout kills a busy harness', () => {
  fake(
    'claude',
    'for (let i = 0; i < 200; i++) { process.stdout.write("{}\\n"); await Bun.sleep(50) }'
  )
  const result = lane([
    brief,
    '--worktree',
    worktree,
    '--watchdog-minutes',
    '0.002',
    '--timeout-minutes',
    '0.005'
  ])
  expect(result.exitCode).toBe(124)
  expect(result.stderr).toBe('simmer lane: timed out after 0.005 minutes\n')
})

// A fake Claude Code for relay tests. Each turn prints an assistant message with the given context,
// then a tool result. After a tool result it acts like the relay hook: when simmer wrote the relay
// file, it takes it and hands the reason to the agent. MODE picks how the agent answers it.
function relayClaude(mode: 'handoff' | 'ignore', contexts: number[]) {
  return `
import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs'
const prompt = process.argv[process.argv.indexOf('-p') + 1]
const run = (existsSync('runs') ? readFileSync('runs', 'utf8').split('\\n').length - 1 : 0) + 1
appendFileSync('runs', run + '\\n')
writeFileSync('prompt-' + run + '.txt', prompt)
writeFileSync('relay-file-' + run + '.txt', process.env.SIMMER_RELAY_FILE ?? 'unset')
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
async function hook() {
  const file = process.env.SIMMER_RELAY_FILE
  for (let i = 0; file && i < 50 && !existsSync(file); i++) await Bun.sleep(10)
  if (!file || !existsSync(file)) return undefined
  renameSync(file, file + '.sent')
  return JSON.parse(readFileSync(file + '.sent', 'utf8')).reason
}
const contexts = run === 1 ? ${JSON.stringify(contexts)} : [1000]
let asked
for (let turn = 0; turn < contexts.length || (asked && ${JSON.stringify(mode)} === 'ignore'); turn++) {
  const context = contexts[Math.min(turn, contexts.length - 1)]
  say({ type: 'assistant', message: { id: run + '-' + turn, content: [{ type: 'tool_use' }],
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: context - 10 } } })
  say({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
  asked ??= await hook()
  if (asked) writeFileSync('asked-' + run + '.txt', asked)
  if (asked && ${JSON.stringify(mode)} === 'handoff') break
  if (turn > 200) break
  await Bun.sleep(5)
}
const text = asked && ${JSON.stringify(mode)} === 'handoff'
  ? 'Done: step one, commit abc123.\\nNext: step two.\\n\\nRELAY-HANDOFF'
  : 'FINISHED run ' + run
say({ type: 'result', result: text,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2000 } })
`
}

function readJson(file: string): LaneUsage {
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('usageSummary is the compact ledger string', () => {
  expect(
    usageSummary({
      inputTokens: 1,
      outputTokens: 463_200,
      cacheReadTokens: 315_400_000,
      cacheWriteTokens: 0,
      turns: 212,
      peakContext: 281_000,
      relays: 1
    })
  ).toBe('out=463k cr=315M turns=212 peak=281k relays=1')
  expect(
    usageSummary({
      inputTokens: 0,
      outputTokens: 950,
      cacheReadTokens: 2_345_678,
      cacheWriteTokens: 0,
      turns: null,
      peakContext: null,
      relays: 0
    })
  ).toBe('out=950 cr=2.3M relays=0')
})

test('--usage-out writes turns, peak context, and the ledger summary', () => {
  fake('claude', relayClaude('handoff', [3000, 5000, 4000]))
  const usage = join(directory, 'usage.json')
  const result = lane([brief, '--worktree', worktree, '--usage-out', usage])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('FINISHED run 1\n')
  expect(result.stderr).toBe(
    'simmer lane: usage: input 10, output 5, cache read 2000, cache write 0, turns 3, peak context 5000\n'
  )
  expect(readJson(usage)).toMatchObject({
    running: false,
    harness: 'claude',
    turns: 3,
    peakContext: 5000,
    outputTokens: 5,
    cacheReadTokens: 2000,
    relays: 0,
    contextCeiling: null,
    runs: [{ ended: 'done', exitCode: 0, turns: 3, peakContext: 5000 }],
    summary: 'out=5 cr=2k turns=3 peak=5k relays=0'
  })
  // Without a ceiling the brief goes to the harness unchanged and no relay hook is set.
  expect(readFileSync(join(worktree, 'prompt-1.txt'), 'utf8')).toBe(readFileSync(brief, 'utf8'))
  expect(readFileSync(join(worktree, 'relay-file-1.txt'), 'utf8')).toBe('unset')
})

test('a relay hands off at the ceiling and a fresh agent continues from the handoff', () => {
  fake('claude', relayClaude('handoff', [3000, 9000, 9500, 9800]))
  const usage = join(directory, 'usage.json')
  const out = join(directory, 'report.md')
  const result = lane([
    brief,
    '--worktree',
    worktree,
    '--context-ceiling',
    '8000',
    '--usage-out',
    usage,
    '--out',
    out
  ])
  expect(result.exitCode).toBe(0)
  expect(readFileSync(join(worktree, 'runs'), 'utf8')).toBe('1\n2\n')
  expect(readFileSync(join(worktree, 'asked-1.txt'), 'utf8')).toBe(
    'SIMMER RELAY: your context is 9000 tokens, past the ceiling of 8000. Follow the relay rule in your brief now.'
  )
  const first = readFileSync(join(worktree, 'prompt-1.txt'), 'utf8')
  expect(first).toStartWith(readFileSync(brief, 'utf8'))
  expect(first).toContain('## Relay rule (from simmer, the tool that runs you)')
  expect(first).toContain('context ceiling of 8000 tokens')
  expect(first).not.toContain('## Relay 1')
  const second = readFileSync(join(worktree, 'prompt-2.txt'), 'utf8')
  expect(second).toStartWith(readFileSync(brief, 'utf8'))
  expect(second).toContain('## Relay 1 of at most 3')
  expect(second).toContain('<handoff>\nDone: step one, commit abc123.\nNext: step two.\n</handoff>')
  expect(second).not.toContain('RELAY-HANDOFF\n</handoff>')
  expect(readFileSync(out, 'utf8')).toBe(
    'FINISHED run 2\n\n---\nsimmer lane: this run used 1 relay(s) at a context ceiling of 8000 tokens (at most 3).'
  )
  expect(result.stderr).toContain('context 9000 passed the ceiling 8000; asked for a relay handoff')
  expect(result.stderr).toContain('relay 1 of at most 3: starting a fresh agent')
  expect(result.stderr).toEndWith(
    'usage: input 20, output 10, cache read 4000, cache write 0, turns 3, peak context 9000, relays 1\n'
  )
  expect(readJson(usage)).toMatchObject({
    running: false,
    turns: 3,
    peakContext: 9000,
    relays: 1,
    maxRelays: 3,
    contextCeiling: 8000,
    runs: [
      { ended: 'relay', turns: 2, peakContext: 9000 },
      { ended: 'done', turns: 1, peakContext: 1000 }
    ],
    summary: 'out=10 cr=4k turns=3 peak=9k relays=1'
  })
  // simmer removes its relay folder.
  const relayFile = readFileSync(join(worktree, 'relay-file-1.txt'), 'utf8')
  expect(existsSync(join(relayFile, '..'))).toBe(false)
})

test('the relay cap lets the last agent run past the ceiling', () => {
  fake('claude', relayClaude('handoff', [9000, 9000]))
  const out = join(directory, 'report.md')
  const result = lane([
    brief,
    '--worktree',
    worktree,
    '--context-ceiling',
    '8000',
    '--max-relays',
    '1',
    '--out',
    out
  ])
  expect(result.exitCode).toBe(0)
  expect(readFileSync(join(worktree, 'runs'), 'utf8')).toBe('1\n2\n')
  const second = readFileSync(join(worktree, 'prompt-2.txt'), 'utf8')
  expect(second).toContain('## Relay 1 of at most 1')
  expect(second).not.toContain('## Relay rule')
  expect(readFileSync(join(worktree, 'relay-file-2.txt'), 'utf8')).toBe('unset')
  expect(readFileSync(out, 'utf8')).toEndWith(
    '(at most 1). That is the cap, so the last agent ran without a ceiling.'
  )
})

test('an agent that ignores the relay request is stopped after a tool call', () => {
  fake('claude', relayClaude('ignore', [9000]))
  const usage = join(directory, 'usage.json')
  const result = lane([
    brief,
    '--worktree',
    worktree,
    '--context-ceiling',
    '8000',
    '--usage-out',
    usage
  ])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toStartWith('FINISHED run 2\n')
  expect(result.stderr).toContain(
    `no handoff ${RELAY_GRACE_TURNS} turns after the relay request; stopping the agent after a tool call`
  )
  const second = readFileSync(join(worktree, 'prompt-2.txt'), 'utf8')
  expect(second).toContain('It did not stop when asked, so simmer stopped it')
  expect(second).not.toContain('<handoff>')
  const report = readJson(usage)
  expect(report.relays).toBe(1)
  expect(report.runs[0]?.ended).toBe('stopped')
  expect(report.runs[0]?.turns).toBeGreaterThanOrEqual(RELAY_GRACE_TURNS + 1)
})

test('a harness without relay support ignores the ceiling with a warning', () => {
  fake('gemini', '')
  const result = lane([
    brief,
    '--worktree',
    worktree,
    '--harness',
    'gemini',
    '--context-ceiling',
    '8000'
  ])
  expect(result.stderr).toContain(
    'simmer lane: gemini cannot relay at a context ceiling; ignoring --context-ceiling'
  )
  expect(invocation()).toContain(readFileSync(brief, 'utf8'))
  expect(invocation()).not.toContain('--settings')
})

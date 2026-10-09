import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../src/config'
import { parseLaneArgs } from '../src/lane'

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

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../src/config'
import { loadConfig } from '../src/config'
import { runHarness } from '../src/harness'
import { rolePrompt } from '../src/harness/process'

let directory: string
let originalPath: string | undefined
const harnesses: Harness[] = ['claude', 'codex', 'pi']

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer-harness-')
  mkdirSync(join(directory, 'bin'))
  originalPath = process.env.PATH
  process.env.PATH = `${join(directory, 'bin')}:${originalPath ?? ''}`
})

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(directory, { recursive: true, force: true })
})

function fake(harness: Harness, body: string, name: string = harness) {
  const binary = join(directory, 'bin', name)
  writeFileSync(
    binary,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs'
writeFileSync('invocation.json', JSON.stringify({
  arguments: process.argv.slice(2), cwd: process.cwd(), stdin: await Bun.stdin.text()
}))
${body}
`,
    { mode: 0o755 }
  )
  return binary
}

async function run(harness: Harness, watchdogMinutes = 1, binary: string = harness) {
  const config = await loadConfig(directory)
  return runHarness({
    prompt: 'Do the task. Keep "quotes" and $variables literal.\nSecond line.',
    cwd: directory,
    config: {
      ...config,
      harness,
      watchdogMinutes,
      harnessPaths: { ...config.harnessPaths, [harness]: binary }
    },
    watchdogIntervalMs: 20
  })
}

function events(values: unknown[]) {
  return `process.stdout.write(${JSON.stringify(values.map((value) => JSON.stringify(value)).join('\n'))})`
}

function invocation(): { arguments: string[]; cwd: string; stdin: string } {
  return JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8'))
}

function git(arguments_: string[]) {
  const result = Bun.spawnSync(['git', ...arguments_], { cwd: directory })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function repository() {
  git(['init', '-q', '-b', 'main'])
  git([
    '-c',
    'user.name=Harness Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'initial'
  ])
}

test('Claude uses unattended flags, role agents, cwd, and empty stdin', async () => {
  writeFileSync(
    join(directory, 'simmer.json'),
    JSON.stringify({
      models: {
        claude: {
          planner: 'plan-model',
          implementer: 'code-model',
          reviewer: 'review-model',
          tester: 'test-model'
        }
      }
    })
  )
  fake(
    'claude',
    events([
      { type: 'assistant', message: { id: 'first', content: [{ type: 'text', text: 'Earlier' }] } },
      {
        type: 'assistant',
        message: {
          id: 'last',
          content: [
            { type: 'thinking', thinking: 'Hidden' },
            { type: 'text', text: 'Done ' },
            { type: 'text', text: 'now' }
          ],
          usage: { input_tokens: 11, output_tokens: 3 }
        }
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'tool',
        message: {
          content: [{ type: 'text', text: 'Subagent text' }]
        }
      },
      {
        type: 'result',
        result: 'Done now',
        usage: {
          input_tokens: 42,
          output_tokens: 7,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 300
        }
      }
    ])
  )
  expect(await run('claude')).toEqual({
    exitCode: 0,
    finalMessage: 'Done now',
    usage: { inputTokens: 42, outputTokens: 7, cacheReadTokens: 9000, cacheWriteTokens: 300 },
    killedByWatchdog: false
  })
  const called = invocation()
  expect(called.cwd).toBe(directory)
  expect(called.stdin).toBe('')
  expect(called.arguments.length).toBe(9)
  expect(called.arguments.slice(0, 8)).toEqual([
    '-p',
    'Do the task. Keep "quotes" and $variables literal.\nSecond line.',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--agents'
  ])
  expect(JSON.parse(called.arguments[8] ?? '')).toEqual({
    planner: {
      description: 'Plans the child task',
      prompt: 'Plan the child task using its spec and the project design.',
      model: 'plan-model'
    },
    implementer: {
      description: 'Implements the child task',
      prompt: 'Implement the approved plan and follow the project rules.',
      model: 'code-model'
    },
    reviewer: {
      description: 'Reviews the plan and code',
      prompt: 'Review the plan and code against the spec. Report errors and risks.',
      model: 'review-model'
    },
    tester: {
      description: 'Checks the child task',
      prompt: 'Check the acceptance criteria and run the project gate.',
      model: 'test-model'
    }
  })
})

const roleText = `Do the task. Keep "quotes" and $variables literal.
Second line.

Cook-it stage roles:
planner: Plan the child task using its spec and the project design.
implementer: Implement the approved plan and follow the project rules.
reviewer: Review the plan and code against the spec. Report errors and risks.
tester: Check the acceptance criteria and run the project gate.`

const defaultRoleText = rolePrompt(
  'Do the task. Keep "quotes" and $variables literal.\nSecond line.',
  { reviewer: 'claude:opus' }
)

test('Codex parses completed items and usage with workspace and network flags', async () => {
  fake(
    'codex',
    events([
      { type: 'thread.started', thread_id: 'thread' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Earlier' } },
      { type: 'item.updated', item: { type: 'agent_message', text: 'Partial' } },
      { type: 'item.completed', item: { type: 'reasoning', text: 'Hidden' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Final Codex' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 12, cached_input_tokens: 80 }
      }
    ])
  )
  expect(await run('codex')).toEqual({
    exitCode: 0,
    finalMessage: 'Final Codex',
    usage: { inputTokens: 20, outputTokens: 12, cacheReadTokens: 80, cacheWriteTokens: 0 },
    killedByWatchdog: false
  })
  expect(invocation()).toEqual({
    arguments: ['exec', '--json', '-s', 'danger-full-access', '-C', directory, defaultRoleText],
    cwd: directory,
    stdin: ''
  })
})

test('Pi uses its configured binary and totals completed assistant usage only', async () => {
  const binary = fake(
    'pi',
    events([
      { type: 'session', version: 3 },
      { type: 'message_update', usage: { input: 900, output: 900 } },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Earlier' },
            { type: 'toolCall', name: 'bash' }
          ],
          usage: { input: 50, output: 4, cacheRead: 500, cacheWrite: 40 }
        }
      },
      {
        type: 'message_end',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'Tool text' }] }
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Final Pi' }],
          usage: { input: 60, output: 6, cacheRead: 600, cacheWrite: 0 }
        }
      },
      { type: 'turn_end', message: { role: 'assistant', usage: { input: 60, output: 6 } } },
      { type: 'agent_end', messages: [] }
    ]),
    'custom pi'
  )
  expect(await run('pi', 1, binary)).toEqual({
    exitCode: 0,
    finalMessage: 'Final Pi',
    usage: { inputTokens: 110, outputTokens: 10, cacheReadTokens: 1100, cacheWriteTokens: 40 },
    killedByWatchdog: false
  })
  expect(invocation()).toEqual({
    arguments: ['-p', '--mode', 'json', defaultRoleText],
    cwd: directory,
    stdin: ''
  })
})

test.each(['codex', 'pi'] satisfies Harness[])(
  '%s defaults run the reviewer through Claude Opus',
  async (harness) => {
    fake(harness, '')
    await run(harness)
    const prompt = invocation().arguments.at(-1) ?? ''
    expect(prompt).toBe(defaultRoleText)
    expect(prompt).toContain('reviewer (model: claude:opus):')
    expect(prompt).toContain(
      'claude -p --model opus --permission-mode bypassPermissions "$(cat "$brief")" < /dev/null'
    )
    for (const role of ['planner', 'implementer', 'tester']) {
      expect(prompt).toContain(`${role}:`)
      expect(prompt).not.toContain(`${role} (model:`)
    }
    expect(prompt).not.toContain('sonnet')
  }
)

test.each(['codex', 'pi'] satisfies Harness[])(
  '%s selects its own configured roles after a harness override',
  async (harness) => {
    writeFileSync(
      join(directory, 'simmer.json'),
      JSON.stringify({
        harness: 'claude',
        models: {
          claude: { reviewer: 'claude-review' },
          codex: { planner: 'gpt-plan', reviewer: 'gpt-review' },
          pi: { planner: 'pi-plan', reviewer: 'pi-review' }
        }
      })
    )
    fake(harness, '')
    await run(harness)
    const prefix = harness === 'codex' ? 'gpt' : 'pi'
    expect(invocation().arguments.at(-1)).toBe(
      roleText
        .replace('planner:', `planner (model: ${prefix}-plan):`)
        .replace('reviewer:', `reviewer (model: ${prefix}-review):`)
    )
  }
)

test.each(['codex', 'pi'] satisfies Harness[])(
  '%s includes every explicitly configured role model',
  async (harness) => {
    writeFileSync(
      join(directory, 'simmer.json'),
      JSON.stringify({
        models: {
          [harness]: {
            planner: `${harness}-plan`,
            implementer: `${harness}-code`,
            reviewer: `${harness}-review`,
            tester: `${harness}-test`
          }
        }
      })
    )
    fake(harness, '')
    await run(harness)
    expect(invocation().arguments.at(-1)).toBe(
      roleText
        .replace('planner:', `planner (model: ${harness}-plan):`)
        .replace('implementer:', `implementer (model: ${harness}-code):`)
        .replace('reviewer:', `reviewer (model: ${harness}-review):`)
        .replace('tester:', `tester (model: ${harness}-test):`)
    )
  }
)

test.each(['codex', 'pi'] satisfies Harness[])(
  '%s prints the configured Claude Sonnet command',
  async (harness) => {
    writeFileSync(
      join(directory, 'simmer.json'),
      JSON.stringify({ models: { [harness]: { reviewer: 'claude:sonnet' } } })
    )
    fake(harness, '')
    await run(harness)
    const prompt = invocation().arguments.at(-1) ?? ''
    expect(prompt).toContain('reviewer (model: claude:sonnet):')
    expect(prompt).toContain(
      'claude -p --model sonnet --permission-mode bypassPermissions "$(cat "$brief")" < /dev/null'
    )
    expect(prompt).toContain('Give this process a read-only brief.')
    expect(prompt).toContain('--output-format json to inspect modelUsage metadata')
  }
)

test.each(['planner', 'implementer', 'reviewer', 'tester'])(
  'the %s Claude command preserves arguments, stdin, cleanup, and exit status',
  async (role) => {
    for (const model of [
      'opus[1m]',
      "sonnet'; touch injected; # $(touch injected) `touch injected` *"
    ]) {
      writeFileSync(
        join(directory, 'simmer.json'),
        JSON.stringify({
          models: { codex: { [role]: `claude:${model}` } }
        })
      )
      fake('codex', '')
      await run('codex')
      const prompt = invocation().arguments.at(-1) ?? ''
      expect(prompt).toContain('Give this process a read-only brief.')
      expect(prompt).toContain('Return proposed changes for the main worker to apply.')
      const section = prompt.slice(prompt.indexOf(`${role} (model:`))
      const script = section.match(/```sh\n([\s\S]*?)\n```/)?.[1]
      expect(script).toBeDefined()
      if (script === undefined) throw new Error('Claude role script is missing')
      const brief =
        'Read files here. Keep "quotes", \'apostrophes\', $variables, $(touch injected), and `touch injected` literal.\nSecond line.'
      const command = script.replace('REPLACE_WITH_SELF_CONTAINED_BRIEF', brief)
      for (const exitCode of [0, 9]) {
        fake(
          'claude',
          `import { readdirSync } from 'node:fs'
if (!readdirSync(process.env.TMPDIR).some((name) => name.startsWith('simmer-${role}-'))) {
  process.exit(99)
}
process.exitCode = ${exitCode}`
        )
        const result = Bun.spawnSync(['sh', '-c', command], {
          cwd: directory,
          env: { ...process.env, TMPDIR: directory }
        })
        expect(result.exitCode).toBe(exitCode)
        expect(invocation()).toEqual({
          arguments: ['-p', '--model', model, '--permission-mode', 'bypassPermissions', brief],
          cwd: directory,
          stdin: ''
        })
        expect(readdirSync(directory).filter((name) => name.startsWith('simmer-'))).toEqual([])
        expect(existsSync(join(directory, 'injected'))).toBe(false)
      }
    }
  }
)

test('Claude combines a custom role model with its own defaults', async () => {
  writeFileSync(
    join(directory, 'simmer.json'),
    JSON.stringify({
      models: {
        claude: { reviewer: 'custom-review' },
        codex: { reviewer: 'gpt-review' }
      }
    })
  )
  fake('claude', '')
  await run('claude')
  const agents = JSON.parse(invocation().arguments.at(-1) ?? '')
  expect(agents.planner.model).toBe('opus')
  expect(agents.implementer.model).toBe('sonnet')
  expect(agents.reviewer.model).toBe('custom-review')
  expect(agents.tester.model).toBe('opus')
})

test('Claude keeps its default roles when only Codex and Pi roles are configured', async () => {
  writeFileSync(
    join(directory, 'simmer.json'),
    JSON.stringify({
      models: { codex: { reviewer: 'gpt-review' }, pi: { reviewer: 'pi-review' } }
    })
  )
  fake('claude', '')
  await run('claude')
  const agents = JSON.parse(invocation().arguments.at(-1) ?? '')
  expect(agents.planner.model).toBe('opus')
  expect(agents.implementer.model).toBe('sonnet')
  expect(agents.reviewer.model).toBe('opus')
  expect(agents.tester.model).toBe('opus')
})

test.each(harnesses)('%s returns a nonzero exit without inventing usage', async (harness) => {
  fake(harness, 'process.stderr.write("failure\\n")\nprocess.exit(9)')
  expect(await run(harness)).toEqual({
    exitCode: 9,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: false
  })
  expect(invocation().stdin).toBe('')
})

test.each(harnesses)('%s keeps its final text and usage on nonzero exit', async (harness) => {
  const output = {
    claude: [
      { type: 'result', result: 'Failed after work', usage: { input_tokens: 25, output_tokens: 5 } }
    ],
    codex: [
      { type: 'item.completed', item: { type: 'agent_message', text: 'Failed after work' } },
      { type: 'turn.completed', usage: { input_tokens: 25, output_tokens: 5 } }
    ],
    pi: [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Failed after work' }],
          usage: { input: 25, output: 5 }
        }
      }
    ]
  }
  fake(harness, `${events(output[harness])}\nprocess.exitCode = 9`)
  expect(await run(harness)).toEqual({
    exitCode: 9,
    finalMessage: 'Failed after work',
    usage: { inputTokens: 25, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    killedByWatchdog: false
  })
})

test.each(harnesses)('%s watchdog kills a silent worker and its child', async (harness) => {
  fake(
    harness,
    `
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e',
  "setTimeout(() => require('fs').writeFileSync('escaped', 'alive'), 1000)"],
  { stdio: ['ignore', 'inherit', 'ignore'] })
writeFileSync('child-pid', String(child.pid))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`
  )
  expect(await run(harness, 0.005)).toEqual({
    exitCode: 137,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: true
  })
  expect(existsSync(join(directory, 'child-pid'))).toBe(true)
  await Bun.sleep(1100)
  expect(existsSync(join(directory, 'escaped'))).toBe(false)
})

test('stdout bytes keep the watchdog alive even without complete JSON lines', async () => {
  fake(
    'codex',
    `
const timer = setInterval(() => process.stdout.write(' '), 50)
setTimeout(() => { clearInterval(timer); process.stdout.write('\\n') }, 700)
`
  )
  expect(await run('codex', 0.005)).toEqual({
    exitCode: 0,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: false
  })
})

test('stderr does not keep a silent worker alive', async () => {
  fake('pi', "setInterval(() => process.stderr.write('busy\\n'), 30)")
  expect(await run('pi', 0.005)).toEqual({
    exitCode: 137,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: true
  })
})

test('the watchdog still kills descendants after the worker exits', async () => {
  fake(
    'codex',
    `
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: ['ignore', 'inherit', 'ignore'] })
child.unref()
process.exit(0)
`
  )
  expect(await run('codex', 0.005)).toEqual({
    exitCode: 0,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: true
  })
})

test('the watchdog kills detached descendants and returns despite inherited stdout', async () => {
  fake(
    'pi',
    `
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e',
  "setTimeout(() => require('fs').writeFileSync('escaped', 'alive'), 1000)"],
  { detached: true, stdio: ['ignore', 'inherit', 'ignore'] })
writeFileSync('child-pid', String(child.pid))
setInterval(() => {}, 1000)
`
  )
  expect(await run('pi', 0.005)).toEqual({
    exitCode: 137,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: true
  })
  await Bun.sleep(1100)
  expect(existsSync(join(directory, 'escaped'))).toBe(false)
})

test('the watchdog finds detached children after their worker exits', async () => {
  fake(
    'pi',
    `
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e',
  "setTimeout(() => require('fs').writeFileSync('escaped', 'alive'), 1000)"],
  { detached: true, stdio: ['ignore', 'inherit', 'ignore'] })
child.unref()
process.exit(0)
`
  )
  expect(await run('pi', 0.005)).toEqual({
    exitCode: 0,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: true
  })
  await Bun.sleep(1100)
  expect(existsSync(join(directory, 'escaped'))).toBe(false)
})

test('new commits keep a silent worker alive and existing commits do not', async () => {
  repository()
  fake(
    'claude',
    `
const timer = setInterval(() => {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Harness Test',
    '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'progress'], { stdout: 'ignore', stderr: 'ignore' })
  if (result.exitCode !== 0) process.exit(8)
}, 100)
setTimeout(() => clearInterval(timer), 750)
`
  )
  expect(await run('claude', 0.005)).toEqual({
    exitCode: 0,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: false
  })
  expect(git(['log', '-1', '--format=%s'])).toBe('progress')
  fake('claude', 'setInterval(() => {}, 1000)')
  expect((await run('claude', 0.005)).killedByWatchdog).toBe(true)
})

test('the first commit also keeps a worker alive in an unborn repository', async () => {
  git(['init', '-q', '-b', 'main'])
  fake(
    'codex',
    `
setTimeout(() => {
  Bun.spawnSync(['git', '-c', 'user.name=Harness Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first'])
}, 150)
setTimeout(() => {}, 400)
`
  )
  expect((await run('codex', 0.005)).killedByWatchdog).toBe(false)
  expect(git(['log', '-1', '--format=%s'])).toBe('first')
})

test('commit activity must continue to prevent a watchdog kill', async () => {
  repository()
  fake(
    'pi',
    `
setTimeout(() => Bun.spawnSync(['git', '-c', 'user.name=Harness Test',
  '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
  'commit', '-q', '--allow-empty', '-m', 'progress']), 150)
setInterval(() => {}, 1000)
`
  )
  expect((await run('pi', 0.005)).killedByWatchdog).toBe(true)
  expect(git(['log', '-1', '--format=%s'])).toBe('progress')
})

test('Claude falls back to assistant text and deduplicates usage by message id', async () => {
  fake(
    'claude',
    events([
      {
        type: 'assistant',
        message: {
          id: 'same',
          content: [{ type: 'text', text: 'Part' }],
          usage: { input_tokens: 10, output_tokens: 2 }
        }
      },
      {
        type: 'assistant',
        message: {
          id: 'same',
          content: [{ type: 'text', text: 'Complete' }],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 150
          }
        }
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'tool',
        message: {
          content: [{ type: 'text', text: 'Subagent' }],
          usage: { input_tokens: 500, output_tokens: 500 }
        }
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'bash' }] } }
    ])
  )
  expect(await run('claude')).toEqual({
    exitCode: 0,
    finalMessage: 'Complete',
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2000, cacheWriteTokens: 150 },
    killedByWatchdog: false
  })
})

test('JSON parsing handles fragmented UTF-8, malformed lines, and an unterminated last line', async () => {
  fake(
    'codex',
    `
process.stdout.write('not JSON\\nnull\\n[]\\n{"type": "unknown"}\\n')
const bytes = Buffer.from('{"type":"item.completed","item":{"type":"agent_message",' +
  '"text":"Final ☕"}}')
const split = bytes.indexOf(Buffer.from('☕')) + 1
process.stdout.write(bytes.subarray(0, split))
setTimeout(() => process.stdout.write(bytes.subarray(split)), 30)
`
  )
  expect(await run('codex')).toEqual({
    exitCode: 0,
    finalMessage: 'Final ☕',
    usage: undefined,
    killedByWatchdog: false
  })
})

test.each(harnesses)('%s rejects a missing binary without leaving a timer', async (harness) => {
  await expect(run(harness, 0.005, join(directory, 'missing'))).rejects.toThrow('ENOENT')
})

test('invalid usage stays undefined while reported zero usage stays zero', async () => {
  fake(
    'codex',
    events([{ type: 'turn.completed', usage: { input_tokens: '42', output_tokens: -1 } }])
  )
  expect((await run('codex')).usage).toBeUndefined()
  fake('codex', events([{ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }]))
  expect((await run('codex')).usage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  })
  fake(
    'claude',
    events([
      {
        type: 'result',
        result: 'Done',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: '9' }
      }
    ])
  )
  expect((await run('claude')).usage).toBeUndefined()
})

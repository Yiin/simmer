import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChild } from '../src/child'
import { loadConfig } from '../src/config'

const cliPath = join(import.meta.dir, '../src/cli.ts')
let directory: string
let repository: string
let environment: NodeJS.ProcessEnv
let scenario: string

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer-child-test-')
  repository = join(directory, 'repo')
  mkdirSync(repository)
  mkdirSync(join(directory, 'bin'))
  environment = {
    ...process.env,
    PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}`,
    BEADS_ACTOR: 'child-test'
  }
  scenario = 'success'
  writeFileSync(join(directory, 'state.json'), '{"status":"open","assignee":""}')
  writeFileSync(join(directory, 'calls.jsonl'), '')
  writeFileSync(join(directory, 'prompts.jsonl'), '')
  writeConfig()
  writeFileSync(join(repository, 'unrelated.txt'), 'initial\n')
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Child Test'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['add', '.'])
  git(['commit', '-qm', 'initial'])
  binary(
    'bd',
    `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const argumentsList = process.argv.slice(2)
const command = argumentsList[0]
const statePath = ${JSON.stringify(join(directory, 'state.json'))}
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const input = readFileSync(0, 'utf8')
appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))},
  JSON.stringify({ arguments: argumentsList, input,
    environmentActor: process.env.BEADS_ACTOR }) + '\\n')
const actor = argumentsList[argumentsList.indexOf('--actor') + 1]
const scenario = readFileSync(${JSON.stringify(join(directory, 'scenario'))}, 'utf8')
if (command === 'show') {
  process.stdout.write(JSON.stringify([{ id: 'task-1.1', title: 'Task',
    status: state.status, parent: 'parent-9', description: 'Change child.txt',
    acceptance_criteria: 'The gate passes', assignee: state.assignee,
    labels: scenario.startsWith('research-') ? ['research'] : [],
    notes: state.notes ?? '', comments: state.comments ?? [] }]))
} else if (command === 'update' && argumentsList.includes('--claim')) {
  if (readFileSync(
    ${JSON.stringify(join(directory, 'scenario'))}, 'utf8') === 'lost') process.exit(13)
  state.status = 'in_progress'
  state.assignee = actor
} else if (command === 'reopen') {
  state.status = 'open'
} else if (command === 'close') {
  state.status = 'closed'
} else if (command === 'heartbeat' && state.status === 'closed' &&
  readFileSync(${JSON.stringify(join(directory, 'scenario'))}, 'utf8') === 'retry') {
  await Bun.sleep(200)
  process.stderr.write('The bead is closed')
  process.exit(1)
} else if (command === 'heartbeat' && scenario.startsWith('heartbeat-')) {
  const countPath = ${JSON.stringify(join(directory, 'heartbeats'))}
  const count = Number(readFileSync(countPath, 'utf8')) + 1
  writeFileSync(countPath, String(count))
  if (scenario === 'heartbeat-lost') {
    state.assignee = 'other-worker'
    writeFileSync(statePath, JSON.stringify(state))
  }
  if (count === 1 || scenario === 'heartbeat-lost') {
    process.stderr.write('Dolt unavailable')
    process.exit(1)
  }
} else if (command === 'unclaim') {
  if (state.assignee !== actor) process.exit(13)
  state.status = 'open'
  state.assignee = ''
} else if (command === 'update') {
  if (argumentsList.includes('--if-assignee') && state.assignee !== actor) process.exit(13)
  state.status = argumentsList[argumentsList.indexOf('--status') + 1]
  if (argumentsList.includes('--assignee')) state.assignee = ''
} else if (command === 'note') {
  state.notes = (state.notes ?? '') + input + '\\n'
  writeFileSync(statePath, JSON.stringify(state))
} else if (command !== 'heartbeat') {
  process.stderr.write('Unexpected bd command')
  process.exit(99)
}
if (command !== 'heartbeat' && command !== 'note' && command !== 'show') {
  writeFileSync(statePath, JSON.stringify(state))
}
`
  )
  const harness = `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
const scenario = readFileSync(${JSON.stringify(join(directory, 'scenario'))}, 'utf8')
const countPath = ${JSON.stringify(join(directory, 'attempts'))}
const attempt = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1
writeFileSync(countPath, String(attempt))
appendFileSync(${JSON.stringify(join(directory, 'prompts.jsonl'))},
  JSON.stringify({ arguments: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
if (scenario.startsWith('heartbeat-')) {
  const countPath = ${JSON.stringify(join(directory, 'heartbeats'))}
  const deadline = Date.now() + 3000
  while (Number(readFileSync(countPath, 'utf8')) < 2 && Date.now() < deadline) {
    await Bun.sleep(10)
  }
  if (scenario === 'heartbeat-lost') await Bun.sleep(150)
}
if (scenario === 'slow' || scenario === 'watchdog') await Bun.sleep(250)
if (scenario === 'watchdog') setInterval(() => {}, 1000)
else {
  if (!['no-commit', 'research-note', 'research-comment', 'research-none',
      'research-old-note', 'unlabeled-note'].includes(scenario) &&
      !(scenario === 'stale-commit' && attempt === 2)) {
    const red = ['red-twice', 'dirty-fix', 'huge-output'].includes(scenario) ||
      (scenario === 'retry' && attempt === 1)
    writeFileSync('child.txt', (red ? 'red' : 'green') + '\\n' + attempt + '\\n')
    if (scenario === 'branch-switch') {
      Bun.spawnSync(['git', 'switch', '-qc', 'wrong-branch'])
    }
    const commitArguments = scenario === 'amend' && attempt === 2
      ? ['commit', '--amend', '-qm', 'worker ' + attempt]
      : ['commit', '-qm', 'worker ' + attempt]
    for (const argumentsList of [['add', 'child.txt'], commitArguments]) {
      const result = Bun.spawnSync(['git', ...argumentsList])
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
  }
  if (scenario === 'dirty-fix') writeFileSync('child.txt', 'green\\n')
  if (['research-note', 'unlabeled-note'].includes(scenario)) {
    const result = Bun.spawnSync(['bd', 'note', 'task-1.1', '--stdin'],
      { stdin: new TextEncoder().encode('Research result') })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  if (scenario === 'research-comment') {
    const statePath = ${JSON.stringify(join(directory, 'state.json'))}
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.comments = [...(state.comments ?? []),
      { id: '7c6467f0-7db7-4f35-bfd8-' + String(attempt).padStart(12, '0'),
        text: 'Research result' }]
    writeFileSync(statePath, JSON.stringify(state))
  }
  if (scenario !== 'not-closed' &&
      !(['stale-commit', 'amend'].includes(scenario) && attempt === 1)) {
    const result = Bun.spawnSync(['bd', 'close', 'task-1.1', '--reason', 'done'])
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  const output = process.argv[2] === 'exec'
    ? [{ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } },
       { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 5 } }]
    : [{ type: 'result', result: 'Done', usage: { input_tokens: 7, output_tokens: 3 } }]
  process.stdout.write(output.map(value => JSON.stringify(value)).join('\\n') + '\\n')
}
`
  binary('codex', harness)
  binary('claude', harness)
  binary(
    'child-gate',
    `
import { appendFileSync, readFileSync } from 'node:fs'
const scenario = readFileSync(${JSON.stringify(join(directory, 'scenario'))}, 'utf8')
appendFileSync(${JSON.stringify(join(directory, 'gates'))}, 'gate\\n')
if (scenario.startsWith('research-') || scenario === 'unlabeled-note') process.exit(0)
if (readFileSync('child.txt', 'utf8').startsWith('red')) {
  if (scenario === 'huge-output') {
    process.stdout.write('💥'.repeat(10000) + '\\nred gate\\n')
    process.exit(7)
  }
  process.stdout.write(Array.from({ length: 100 }, (_, index) => 'gate line ' + index).join('\\n'))
  process.stderr.write('\\nred gate\\n')
  process.exit(7)
}
process.stdout.write('green gate\\n')
`
  )
})

afterEach(() => {
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ') && line.slice(9) !== repository) {
      rmSync(line.slice(9), { recursive: true, force: true })
    }
  }
  rmSync(directory, { recursive: true, force: true })
})

function git(argumentsList: string[], cwd = repository): string {
  const result = Bun.spawnSync(['git', ...argumentsList], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function binary(name: string, source: string) {
  writeFileSync(join(directory, 'bin', name), `#!${process.execPath}\n${source}`, { mode: 0o755 })
}

function writeConfig(watchdogMinutes = 1) {
  writeFileSync(
    join(repository, 'simmer.json'),
    JSON.stringify({
      harness: 'codex',
      gate: 'child-gate',
      watchdogMinutes
    })
  )
}

function records(name: string): Record<string, unknown>[] {
  return readFileSync(join(directory, name), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function state(): { status: string; assignee: string; notes?: string } {
  return JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
}

function calls(command: string) {
  return records('calls.jsonl').filter(
    (call) => Array.isArray(call.arguments) && call.arguments[0] === command
  )
}

function run(...argumentsList: string[]) {
  writeFileSync(join(directory, 'scenario'), scenario)
  const child = Bun.spawnSync(
    [process.execPath, cliPath, 'child', 'task-1.1', '--json', ...argumentsList],
    { cwd: repository, env: environment }
  )
  const events: Record<string, unknown>[] = child.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return { exitCode: child.exitCode, stderr: child.stderr.toString(), events }
}

test('lands the first attempt and records facts on the child and its actual parent', () => {
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.events.map((event) => event.event)).toEqual([
    'claimed',
    'attempt-started',
    'gate',
    'attempt-finished',
    'landed',
    'done'
  ])
  expect(readFileSync(join(repository, 'child.txt'), 'utf8')).toBe('green\n1\n')
  expect(state().status).toBe('closed')
  expect(calls('note').map((call) => Array.isArray(call.arguments) && call.arguments[1])).toEqual([
    'task-1.1',
    'parent-9'
  ])
  const report = calls('note')[0]?.input
  expect(typeof report).toBe('string')
  if (typeof report !== 'string') throw new Error('Missing attempt note')
  expect(JSON.parse(report)).toEqual({
    harness: 'codex',
    models: { planner: 'opus', implementer: 'sonnet', reviewer: 'opus', tester: 'opus' },
    attempt: 1,
    durationMs: expect.any(Number),
    usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 0 },
    harnessExit: 0,
    gateExit: 0,
    commitCount: 1,
    outcome: 'passed'
  })
  const prompt = records('prompts.jsonl')[0]?.arguments
  expect(JSON.stringify(prompt)).toContain('Follow the cook-it skill (in your skills folder)')
  expect(JSON.stringify(prompt)).toContain('Do not push.')
  expect(JSON.stringify(prompt)).toContain('Work only in this directory.')
  expect(JSON.stringify(prompt)).toContain('Commit your work here.')
  expect(JSON.stringify(prompt)).toContain('bd close task-1.1 --reason ...')
})

test('reopens a red gate and passes with a fresh worker and the last 80 output lines', () => {
  scenario = 'retry'
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(calls('reopen')).toHaveLength(1)
  expect(calls('note')).toHaveLength(3)
  expect(
    result.events.filter((event) => event.event === 'gate').map((event) => event.exitCode)
  ).toEqual([7, 0])
  const firstGate = result.events.find((event) => event.event === 'gate')
  expect(typeof firstGate?.output).toBe('string')
  if (typeof firstGate?.output !== 'string') throw new Error('Missing gate output')
  expect(firstGate.output.split('\n')).toHaveLength(80)
  expect(firstGate.output).toBe(
    `${Array.from({ length: 79 }, (_, index) => `gate line ${index + 21}`).join('\n')}\nred gate`
  )
  expect(JSON.stringify(records('prompts.jsonl')[1]?.arguments)).toContain('Previous failure:')
  expect(JSON.stringify(records('prompts.jsonl')[1]?.arguments)).toContain(
    "The first attempt's commits are already on this branch. Build on them."
  )
  expect(JSON.stringify(records('prompts.jsonl')[1]?.arguments)).toContain('red gate')
  expect(readFileSync(join(repository, 'child.txt'), 'utf8')).toBe('green\n2\n')
})

test.each(['red-twice', 'no-commit', 'not-closed'])(
  '%s blocks after two attempts and preserves child commits',
  (failure) => {
    scenario = failure
    const result = run()
    expect(result.exitCode).toBe(2)
    expect(state()).toEqual({ status: 'blocked', assignee: '', notes: expect.any(String) })
    expect(calls('note')).toHaveLength(3)
    expect(result.events.filter((event) => event.event === 'attempt-started')).toHaveLength(2)
    expect(result.events.slice(-2).map((event) => event.event)).toEqual(['blocked', 'done'])
    const expected =
      failure === 'red-twice'
        ? 'Gate exited 7:'
        : failure === 'not-closed'
          ? 'bead not closed'
          : 'no commit'
    expect(result.events.find((event) => event.event === 'blocked')?.reason).toContain(expected)
    expect(JSON.stringify(records('prompts.jsonl')[1]?.arguments)).toContain(expected)
    const worktree = result.events.find((event) => event.event === 'attempt-started')?.worktree
    if (typeof worktree !== 'string') throw new Error('Missing worktree')
    expect(git(['rev-list', '--count', 'main..HEAD'], worktree)).toBe(
      failure === 'no-commit' ? '0' : '2'
    )
    expect(git(['log', '-1', '--format=%s'])).toBe('initial')
  }
)

test('lands beside an unrelated dirty file', () => {
  writeFileSync(join(repository, 'unrelated.txt'), 'local\n')
  expect(run().exitCode).toBe(0)
  expect(readFileSync(join(repository, 'unrelated.txt'), 'utf8')).toBe('local\n')
  expect(readFileSync(join(repository, 'child.txt'), 'utf8')).toBe('green\n1\n')
})

test('claim loss exits 3 without a worker or heartbeat', () => {
  scenario = 'lost'
  const result = run()
  expect(result.exitCode).toBe(3)
  expect(result.stderr).toBe('')
  expect(result.events).toEqual([{ event: 'done', id: 'task-1.1', outcome: 'claim-lost' }])
  expect(calls('heartbeat')).toHaveLength(0)
  expect(records('prompts.jsonl')).toEqual([])
})

test('adopts the supplied worktree and skips landing', () => {
  const path = join(directory, 'assigned')
  git(['worktree', 'add', '-qb', 'assigned', path])
  expect(run('--worktree', path, '--no-land').exitCode).toBe(0)
  expect(git(['branch', '--show-current'], path)).toBe('assigned')
  expect(git(['log', '-1', '--format=%s'])).toBe('initial')
  expect(git(['log', '-1', '--format=%s'], path)).toBe('worker 1')
  expect(calls('note')).toHaveLength(1)
})

test.each(['stale-commit', 'amend'])('%s retry checks commits since the child started', (mode) => {
  scenario = mode
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(
    result.events
      .filter((event) => event.event === 'attempt-finished')
      .map((event) => event.commitCount)
  ).toEqual(mode === 'amend' ? [1, 1] : [1, 0])
  expect(state().status).toBe('closed')
})

test('a changed branch fails even with no landing', () => {
  scenario = 'branch-switch'
  const result = run('--no-land')
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe('Worker changed the worktree branch\n')
  expect(result.events.some((event) => event.event === 'done')).toBe(false)
})

test('overlapping dirty files defer landing and record the parent note', () => {
  writeFileSync(join(repository, 'child.txt'), 'local\n')
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(result.events.find((event) => event.event === 'deferred')).toEqual({
    event: 'deferred',
    id: 'task-1.1',
    kind: 'deferred',
    files: ['child.txt']
  })
  expect(calls('note')).toHaveLength(2)
  expect(readFileSync(join(repository, 'child.txt'), 'utf8')).toBe('local\n')
  expect(git(['show', 'simmer/parent-9:child.txt'])).toBe('green\n1')
})

test('claim and worker share a unique actor', () => {
  expect(run().exitCode).toBe(0)
  const claim = calls('update')[0]?.arguments
  if (!Array.isArray(claim)) throw new Error('Missing bd claim')
  const actor: unknown = claim[claim.indexOf('--actor') + 1]
  expect(typeof actor).toBe('string')
  if (typeof actor !== 'string') throw new Error('Missing actor')
  expect(actor.startsWith('child-test-')).toBe(true)
  expect(calls('close')[0]?.environmentActor).toBe(actor)
})

test('a conflicting run branch blocks the bead and preserves the child commits', () => {
  const assigned = join(directory, 'assigned')
  const runPath = join(directory, 'run-branch')
  git(['worktree', 'add', '-qb', 'assigned', assigned])
  git(['worktree', 'add', '-qb', 'simmer/parent-9', runPath])
  writeFileSync(join(runPath, 'child.txt'), 'other child\n')
  git(['add', 'child.txt'], runPath)
  git(['commit', '-qm', 'other child'], runPath)
  const result = run('--worktree', assigned)
  expect(result.exitCode).toBe(2)
  expect(state()).toEqual({ status: 'blocked', assignee: '', notes: expect.any(String) })
  expect(result.events.some((event) => event.event === 'conflict')).toBe(true)
  expect(calls('note').at(-1)?.input).toContain('assigned')
  expect(git(['log', '-1', '--format=%s'], assigned)).toBe('worker 1')
})

test('the harness flag selects the Claude cook-it prompt', () => {
  const result = run('--harness', 'claude')
  expect(result.exitCode).toBe(0)
  expect(JSON.stringify(records('prompts.jsonl')[0]?.arguments)).toContain('/cook-it task-1.1')
  expect(result.events.find((event) => event.event === 'attempt-finished')?.harness).toBe('claude')
})

test('a watchdog kill gets one retry and then blocks', () => {
  scenario = 'watchdog'
  writeConfig(0.001)
  const result = run()
  expect(result.exitCode).toBe(2)
  expect(state().status).toBe('blocked')
  expect(result.events.find((event) => event.event === 'blocked')?.reason).toContain(
    'watchdog kill'
  )
  expect(calls('note')).toHaveLength(3)
})

test.each(['slow', 'red-twice', 'missing-harness', 'retry'])(
  'heartbeat stops after %s, including unexpected errors',
  async (mode) => {
    scenario = mode
    writeFileSync(join(directory, 'scenario'), scenario)
    const config = await loadConfig(repository)
    if (mode === 'missing-harness') config.harnessPaths.codex = join(directory, 'missing')
    const originalEnvironment = { PATH: process.env.PATH, BEADS_ACTOR: process.env.BEADS_ACTOR }
    process.env.PATH = environment.PATH
    process.env.BEADS_ACTOR = environment.BEADS_ACTOR
    try {
      const running = runChild({
        id: 'task-1.1',
        cwd: repository,
        config,
        json: true,
        heartbeatIntervalMs: 30
      })
      if (mode === 'missing-harness') await expect(running).rejects.toThrow('ENOENT')
      else expect((await running).exitCode).toBe(mode === 'red-twice' ? 2 : 0)
      const count = calls('heartbeat').length
      if (mode === 'slow') expect(count).toBeGreaterThan(0)
      await Bun.sleep(120)
      expect(calls('heartbeat')).toHaveLength(count)
    } finally {
      for (const key of ['PATH', 'BEADS_ACTOR'] as const) {
        const value = originalEnvironment[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
)

test('human output stays short', () => {
  writeFileSync(join(directory, 'scenario'), scenario)
  const result = Bun.spawnSync([process.execPath, cliPath, 'child', 'task-1.1'], {
    cwd: repository,
    env: environment
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toBe(
    'task-1.1: claimed\ntask-1.1: attempt-started (attempt 1)\n' +
      'task-1.1: gate (attempt 1, exit 0)\ntask-1.1: attempt-finished (attempt 1)\n' +
      'task-1.1: landed\ntask-1.1: done\n'
  )
})

test('committed red code with an uncommitted fix fails before the gate', () => {
  scenario = 'dirty-fix'
  const result = run()
  expect(result.exitCode).toBe(2)
  expect(state().status).toBe('blocked')
  expect(result.events.find((event) => event.event === 'blocked')?.reason).toBe(
    'uncommitted changes'
  )
  expect(JSON.stringify(records('prompts.jsonl')[1]?.arguments)).toContain('uncommitted changes')
  expect(existsSync(join(directory, 'gates'))).toBe(false)
  expect(git(['log', '-1', '--format=%s'])).toBe('initial')
})

test('blocked notes name a retained branch under .git/simmer-tmp', () => {
  scenario = 'red-twice'
  const result = run()
  const path = result.events.find((event) => event.event === 'attempt-started')?.worktree
  if (typeof path !== 'string') throw new Error('Missing worktree')
  expect(path.startsWith(join(repository, '.git/simmer-tmp/'))).toBe(true)
  const branch = git(['branch', '--show-current'], path)
  expect(calls('note').at(-1)?.input).toContain(branch)
})

test('retry failure output is limited to 8 KB and valid UTF-8', () => {
  scenario = 'huge-output'
  const result = run()
  expect(result.exitCode).toBe(2)
  const gate = result.events.find((event) => event.event === 'gate')
  if (typeof gate?.output !== 'string') throw new Error('Missing gate output')
  expect(Buffer.byteLength(gate.output)).toBeLessThanOrEqual(8192)
  expect(gate.output).not.toContain('�')
  expect(gate.output.endsWith('red gate')).toBe(true)
  const prompt = records('prompts.jsonl')[1]?.arguments
  if (!Array.isArray(prompt)) throw new Error('Missing retry prompt')
  const text = prompt.find(
    (value: unknown) => typeof value === 'string' && value.includes('Previous failure:')
  )
  expect(typeof text).toBe('string')
  if (typeof text !== 'string') throw new Error('Missing failure')
  const failure = (text.split('Previous failure:')[1] ?? '').split('\n\nCook-it stage roles:')[0]
  expect(Buffer.byteLength(failure ?? '')).toBeLessThanOrEqual(8192)
})

test.each(['newCommits', 'newCommits-unclaimed', 'integrate', 'land', 'merge', 'push'])(
  'an error in %s after close preserves the correct bead status',
  (stage) => {
    if (stage === 'push') {
      writeFileSync(
        join(repository, 'simmer.json'),
        JSON.stringify({ harness: 'codex', gate: 'child-gate', push: true })
      )
    }
    const realGit = Bun.which('git')
    if (!realGit) throw new Error('Missing Git')
    binary(
      'git',
      `
import { readFileSync, writeFileSync } from 'node:fs'
const argumentsList = process.argv.slice(2)
const closed = JSON.parse(readFileSync(${JSON.stringify(join(directory, 'state.json'))},
  'utf8')).status === 'closed'
const stage = ${JSON.stringify(stage)}
let integrationCheck = false
if (closed && stage === 'integrate' && argumentsList[4] === 'symbolic-ref') {
  const counterPath = ${JSON.stringify(join(directory, 'integration-checks'))}
  const previous = Number(await Bun.file(counterPath).text().catch(() => '0'))
  writeFileSync(counterPath, String(previous + 1))
  integrationCheck = previous > 0
}
if (closed && ((stage.startsWith('newCommits') && argumentsList[4] === 'rev-list') ||
    integrationCheck ||
    (stage === 'merge' && argumentsList[4] === 'merge') ||
    (stage === 'push' && argumentsList[4] === 'push') ||
    (stage === 'land' && argumentsList[4] === 'merge-base' &&
      argumentsList.includes('refs/heads/main')))) {
  if (stage === 'newCommits-unclaimed') {
    const statePath = ${JSON.stringify(join(directory, 'state.json'))}
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.assignee = ''
    writeFileSync(statePath, JSON.stringify(state))
  }
  process.stderr.write('injected Git failure')
  process.exit(42)
}
const result = Bun.spawnSync([${JSON.stringify(realGit)}, ...argumentsList],
  { stdout: 'inherit', stderr: 'inherit' })
process.exit(result.exitCode)
`
    )
    const result = run()
    if (stage === 'integrate' || stage === 'land' || stage === 'merge' || stage === 'push') {
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(state().status).toBe('closed')
      expect(calls('reopen')).toHaveLength(0)
      expect(calls('unclaim')).toHaveLength(0)
      expect(calls('update')).toHaveLength(1)
      if (stage !== 'integrate') {
        expect(git(['show', 'simmer/parent-9:child.txt'])).toBe('green\n1')
      }
      const deferred = result.events.find((event) => event.event === 'deferred')
      expect(deferred?.reason).toContain('injected Git failure')
      expect(result.events.at(-1)).toEqual({
        event: 'done',
        id: 'task-1.1',
        outcome: 'deferred'
      })
      const note = calls('note').at(-1)
      expect(Array.isArray(note?.arguments) && note.arguments[1]).toBe('parent-9')
      if (typeof note?.input !== 'string') throw new Error('Missing landing note')
      expect(JSON.parse(note.input.split('\n')[0] ?? '')).toEqual({
        id: 'task-1.1',
        branch: expect.any(String),
        kind: 'deferred',
        files: [],
        reason: expect.stringContaining('injected Git failure')
      })
      return
    }
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('injected Git failure')
    expect(state().status).toBe('open')
    expect(state().assignee).toBe('')
    expect(calls('reopen')).toHaveLength(1)
    expect(calls('unclaim')).toHaveLength(stage === 'newCommits-unclaimed' ? 0 : 1)
    const path = result.events.find((event) => event.event === 'attempt-started')?.worktree
    if (typeof path !== 'string') throw new Error('Missing worktree')
    const branch = git(['branch', '--show-current'], path)
    const notes = calls('note').slice(-2)
    expect(notes.map((note) => Array.isArray(note.arguments) && note.arguments[1])).toEqual([
      'task-1.1',
      'parent-9'
    ])
    for (const note of notes) {
      expect(note.input).toContain(branch)
      expect(note.input).toContain('injected Git failure')
    }
  }
)

test('a base conflict after integration defers landing and keeps the bead closed', () => {
  const assigned = join(directory, 'assigned')
  git(['worktree', 'add', '-qb', 'assigned', assigned])
  git(['branch', 'simmer/parent-9'])
  writeFileSync(join(repository, 'child.txt'), 'base change\n')
  git(['add', 'child.txt'])
  git(['commit', '-qm', 'base change'])
  const result = run('--worktree', assigned)
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(state().status).toBe('closed')
  expect(calls('reopen')).toHaveLength(0)
  expect(calls('unclaim')).toHaveLength(0)
  expect(calls('update')).toHaveLength(1)
  expect(git(['show', 'simmer/parent-9:child.txt'])).toBe('green\n1')
  expect(readFileSync(join(repository, 'child.txt'), 'utf8')).toBe('base change\n')
  const deferred = result.events.find((event) => event.event === 'deferred')
  expect(deferred?.reason).toContain('git rebase failed')
  const note = calls('note').at(-1)
  expect(Array.isArray(note?.arguments) && note.arguments[1]).toBe('parent-9')
  if (typeof note?.input !== 'string') throw new Error('Missing landing note')
  expect(JSON.parse(note.input.split('\n')[0] ?? '')).toEqual({
    id: 'task-1.1',
    branch: 'assigned',
    kind: 'deferred',
    files: [],
    reason: expect.stringContaining('git rebase failed')
  })
})

test.each([
  'research-note',
  'research-comment',
  'unlabeled-note',
  'research-none',
  'research-old-note'
])('%s checks worker effects without trusting simmer notes', (mode) => {
  scenario = mode
  if (mode === 'research-old-note') {
    writeFileSync(
      join(directory, 'state.json'),
      JSON.stringify({
        status: 'open',
        assignee: '',
        notes: 'Existing research result'
      })
    )
  }
  const result = run()
  const passed = ['research-note', 'research-comment'].includes(mode)
  expect(result.exitCode).toBe(passed ? 0 : 2)
  expect(state().status).toBe(passed ? 'closed' : 'blocked')
  expect(git(['log', '-1', '--format=%s'])).toBe('initial')
})

test.each(['heartbeat-blip', 'heartbeat-lost'])(
  '%s verifies ownership before stopping',
  async (mode) => {
    scenario = mode
    writeFileSync(join(directory, 'scenario'), scenario)
    writeFileSync(join(directory, 'heartbeats'), '0')
    const config = await loadConfig(repository)
    const originalEnvironment = { PATH: process.env.PATH, BEADS_ACTOR: process.env.BEADS_ACTOR }
    process.env.PATH = environment.PATH
    process.env.BEADS_ACTOR = environment.BEADS_ACTOR
    try {
      const running = runChild({
        id: 'task-1.1',
        cwd: repository,
        config,
        json: true,
        heartbeatIntervalMs: 30
      })
      if (mode === 'heartbeat-lost') {
        await expect(running).rejects.toThrow('Claim lost to other-worker')
        expect(state().assignee).toBe('other-worker')
        expect(calls('close')).toHaveLength(0)
        expect(calls('reopen')).toHaveLength(0)
        expect(calls('unclaim')).toHaveLength(0)
      } else {
        expect((await running).exitCode).toBe(0)
        expect(calls('heartbeat').length).toBeGreaterThanOrEqual(2)
        expect(state().status).toBe('closed')
      }
      const count = calls('heartbeat').length
      await Bun.sleep(120)
      expect(calls('heartbeat')).toHaveLength(count)
    } finally {
      for (const key of ['PATH', 'BEADS_ACTOR'] as const) {
        const value = originalEnvironment[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
)

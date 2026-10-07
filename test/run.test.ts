import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

type FakeIssue = {
  id: string
  title: string
  status: string
  assignee: string
  notes: string
  parent?: string
  lease_expires_at?: string
  waiting?: boolean
}

const cliPath = join(import.meta.dir, '../src/cli.ts')
let directory: string
let repository: string
let environment: NodeJS.ProcessEnv

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer-run-test-')
  repository = join(directory, 'repo')
  mkdirSync(repository)
  mkdirSync(join(directory, 'bin'))
  environment = {
    ...process.env,
    PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}`
  }
  writeFileSync(
    join(repository, 'simmer.json'),
    JSON.stringify({
      harness: 'codex',
      gate: 'true',
      push: false
    })
  )
  writeFileSync(join(repository, 'shared.txt'), 'initial\n')
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Run Test'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['add', '.'])
  git(['commit', '-qm', 'initial'])
  save([child(1), child(2), child(3)])
  binary(
    'bd',
    `
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
const argumentsList = process.argv.slice(2)
const command = argumentsList[0]
const statePath = ${JSON.stringify(join(directory, 'state.json'))}
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const input = readFileSync(0, 'utf8')
appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))},
  JSON.stringify({ arguments: argumentsList, input }) + '\\n')
const issue = state.find(issue => issue.id === argumentsList[1])
const actor = argumentsList[argumentsList.indexOf('--actor') + 1]
if (command === 'show') {
  if (!issue) process.exit(1)
  process.stdout.write(JSON.stringify([issue]))
} else if (command === 'list') {
  const children = state.filter(issue => issue.parent ===
    argumentsList[argumentsList.indexOf('--parent') + 1])
  process.stdout.write(JSON.stringify(argumentsList.includes('--ready')
    ? children.filter(issue => issue.status === 'open' && !issue.waiting &&
      (issue.title !== 'needs-first' || state.find(child => child.id === 'epic.1').status === 'closed'))
    : children))
} else if (command === 'reclaim') {
  const ids = argumentsList[argumentsList.indexOf('--id') + 1].split(',')
  for (const child of state) {
    if (ids.includes(child.id) && Date.parse(child.lease_expires_at) <= Date.now()) {
      child.status = 'open'
      child.assignee = ''
      delete child.lease_expires_at
    }
  }
} else if (command === 'update' && argumentsList.includes('--claim')) {
  if (issue.title === 'error') {
    process.stderr.write('database unavailable')
    process.exit(1)
  }
  if (issue.title === 'lost') {
    issue.status = 'in_progress'
    issue.assignee = 'another-worker'
    writeFileSync(statePath, JSON.stringify(state))
    process.exit(13)
  }
  if (existsSync(${JSON.stringify(join(directory, 'pause-claim'))})) {
    writeFileSync(${JSON.stringify(join(directory, 'paused'))}, String(process.pid))
    while (!existsSync(${JSON.stringify(join(directory, 'resume'))})) await Bun.sleep(10)
  }
  if (issue.assignee && issue.assignee !== actor) {
    process.stderr.write('Error updating ' + issue.id + ': issue already assigned to ' + issue.assignee)
    process.exit(1)
  }
  issue.status = 'in_progress'
  issue.assignee = actor
  issue.lease_expires_at = new Date(Date.now() + 300000).toISOString()
} else if (command === 'update') {
  if (argumentsList.includes('--if-assignee') && issue.assignee !==
      argumentsList[argumentsList.indexOf('--if-assignee') + 1]) process.exit(13)
  if (argumentsList.includes('--if-status') && issue.status !==
      argumentsList[argumentsList.indexOf('--if-status') + 1]) process.exit(13)
  if (argumentsList.includes('--status')) {
    issue.status = argumentsList[argumentsList.indexOf('--status') + 1]
  }
  if (argumentsList.includes('--assignee')) {
    issue.assignee = ''
    delete issue.lease_expires_at
  }
} else if (command === 'close') issue.status = 'closed'
else if (command === 'reopen') {
  issue.status = 'open'
  delete issue.lease_expires_at
}
else if (command === 'unclaim') {
  issue.status = 'open'
  issue.assignee = ''
  delete issue.lease_expires_at
} else if (command === 'note') {
  const failureMarker = ${JSON.stringify(join(directory, 'fail-landing-note'))}
  if (input.includes('simmer: verified') && input.includes('"kind"') &&
      !input.includes('Landing was interrupted') && existsSync(failureMarker)) {
    rmSync(failureMarker)
    process.stderr.write('timed out writing landing note')
    process.exit(124)
  }
  if (input.includes('simmer: landed') &&
      existsSync(${JSON.stringify(join(directory, 'pause-landed'))})) {
    writeFileSync(${JSON.stringify(join(directory, 'paused'))}, String(process.pid))
    while (!existsSync(${JSON.stringify(join(directory, 'resume'))})) await Bun.sleep(10)
  }
  issue.notes += input + '\\n'
}
else if (command !== 'heartbeat') process.exit(99)
if (command !== 'list' && command !== 'show') writeFileSync(statePath, JSON.stringify(state))
if (command === 'reopen' && existsSync(${JSON.stringify(join(directory, 'pause-reopen'))})) {
  writeFileSync(${JSON.stringify(join(directory, 'paused'))}, String(process.pid))
  while (!existsSync(${JSON.stringify(join(directory, 'resume'))})) await Bun.sleep(10)
}
if (command === 'update' && argumentsList.includes('--claim') &&
    issue.notes.includes('"gateExit":7') &&
    existsSync(${JSON.stringify(join(directory, 'pause-reclaim'))})) {
  writeFileSync(${JSON.stringify(join(directory, 'paused'))}, String(process.pid))
  while (!existsSync(${JSON.stringify(join(directory, 'resume'))})) await Bun.sleep(10)
}
`
  )
  binary(
    'codex',
    `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1)
const id = /bead (epic\\.\\d+)/.exec(prompt)[1]
const state = JSON.parse(readFileSync(${JSON.stringify(join(directory, 'state.json'))}, 'utf8'))
const issue = state.find(issue => issue.id === id)
if (issue.title === 'lose-owner') {
  issue.assignee = 'another-worker'
  issue.status = 'in_progress'
  writeFileSync(${JSON.stringify(join(directory, 'state.json'))}, JSON.stringify(state))
  process.exit(0)
}
if (issue.title === 'pause') {
  writeFileSync(${JSON.stringify(join(directory, 'paused'))}, String(process.pid))
  while (!existsSync(${JSON.stringify(join(directory, 'resume'))})) await Bun.sleep(10)
}
if (issue.title !== 'blocked') {
  if (issue.title === 'needs-first' && !existsSync('epic.1.txt')) process.exit(0)
  if (issue.title === 'clear-overlap') {
    writeFileSync(${JSON.stringify(join(repository, 'shared.txt'))}, 'initial\\n')
  }
  const file = issue.title === 'overlap' ? 'shared.txt' : id + '.txt'
  writeFileSync(file, id + (prompt.includes('Previous failure:') ? ' repaired' : '') + '\\n')
  for (const argumentsList of [['add', file], ['commit', '-qm', id]]) {
    const result = Bun.spawnSync(['git', ...argumentsList])
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  const result = Bun.spawnSync(['bd', 'close', id])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  if (issue.title === 'closed-pause') {
    writeFileSync(${JSON.stringify(join(directory, 'paused'))}, String(process.pid))
    while (!existsSync(${JSON.stringify(join(directory, 'resume'))})) await Bun.sleep(10)
  }
}
process.stdout.write(JSON.stringify({ type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')
`
  )
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function binary(name: string, source: string) {
  writeFileSync(join(directory, 'bin', name), `#!${process.execPath}\n${source}`, { mode: 0o755 })
}

function child(number: number, title = 'success'): FakeIssue {
  return { id: `epic.${number}`, title, parent: 'epic', status: 'open', assignee: '', notes: '' }
}

function save(children: FakeIssue[], notes = '') {
  writeFileSync(
    join(directory, 'state.json'),
    JSON.stringify([
      { id: 'epic', title: 'Epic', status: 'open', assignee: '', notes },
      ...children
    ])
  )
}

function state(): FakeIssue[] {
  return JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
}

function git(argumentsList: string[], cwd = repository): string {
  const result = Bun.spawnSync(['git', ...argumentsList], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function run(commandArguments = ['run', 'epic', '--json']) {
  const result = Bun.spawnSync([process.execPath, cliPath, ...commandArguments], {
    cwd: repository,
    env: environment
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  }
}

function events(output: string): Record<string, unknown>[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function calls(): { arguments: string[]; input: string }[] {
  return readFileSync(join(directory, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

async function waitForPause() {
  const deadline = Date.now() + 5000
  while (!existsSync(join(directory, 'paused')) && Date.now() < deadline) await Bun.sleep(10)
  expect(existsSync(join(directory, 'paused'))).toBe(true)
}

function startRun(commandArguments = ['run', 'epic', '--json']) {
  const processHandle = spawn(process.execPath, [cliPath, ...commandArguments], {
    cwd: repository,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  processHandle.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  processHandle.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const completion = new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      processHandle.on('error', reject)
      processHandle.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }))
    }
  )
  function kill() {
    if (processHandle.pid && processHandle.exitCode === null && processHandle.signalCode === null) {
      process.kill(-processHandle.pid, 'SIGKILL')
      if (existsSync(join(directory, 'paused'))) {
        const pausedId = Number(readFileSync(join(directory, 'paused'), 'utf8'))
        for (const targetId of [-pausedId, pausedId]) {
          try {
            process.kill(targetId, 'SIGKILL')
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
          }
        }
      }
    }
  }
  return { completion, kill, signal: (signal: NodeJS.Signals) => processHandle.kill(signal) }
}

test('one blocked child does not stop two other children from landing', () => {
  save([child(3), child(1, 'blocked'), child(2)])
  const result = run()
  expect(result.exitCode).toBe(4)
  expect(result.stderr).toBe('')
  const output = events(result.stdout)
  expect(output[0]).toEqual({ event: 'run-started', epic: 'epic' })
  expect(output.filter((event) => event.event === 'claimed').map((event) => event.id)).toEqual([
    'epic.3',
    'epic.1',
    'epic.2'
  ])
  expect(output.at(-1)).toEqual({
    event: 'run-finished',
    epic: 'epic',
    counts: { done: 2, blocked: 1, lost: 0, errors: 0, deferred: 0 },
    exitCode: 4,
    deferred: []
  })
  expect(
    state()
      .slice(1)
      .map((issue) => [issue.id, issue.status])
  ).toEqual([
    ['epic.3', 'closed'],
    ['epic.1', 'blocked'],
    ['epic.2', 'closed']
  ])
  expect(git(['show', 'main:epic.2.txt'])).toBe('epic.2')
  expect(git(['show', 'main:epic.3.txt'])).toBe('epic.3')
  expect(existsSync(join(repository, '.git/simmer-tmp/epic.lock'))).toBe(false)
})

test('kill mid-child, expire its lease, and rerun reclaims and finishes it', async () => {
  save([child(1, 'pause')])
  const first = startRun()
  try {
    await waitForPause()
    expect(state()[1]?.status).toBe('in_progress')
    first.kill()
    await first.completion
    expect(existsSync(join(repository, '.git/simmer-tmp/epic.lock'))).toBe(true)
    const claimed = state()[1]
    if (!claimed) throw new Error('Missing claimed child')
    save([{ ...claimed, title: 'success', lease_expires_at: '2000-01-01T00:00:00Z' }])
    const result = run()
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(state()[1]?.status).toBe('closed')
    expect(
      calls()
        .filter((call) => call.arguments[0] === 'reclaim')
        .map((call) => call.arguments)
    ).toEqual([
      [
        'reclaim',
        '--id',
        'epic.1',
        '--older-than',
        '0s',
        '--json',
        '--actor',
        expect.stringMatching(/^simmer-run-\d+$/)
      ]
    ])
    expect(git(['show', 'main:epic.1.txt'])).toBe('epic.1')
    expect(existsSync(join(repository, '.git/simmer-tmp/epic.lock'))).toBe(false)
  } finally {
    first.kill()
    await first.completion
  }
}, 15000)

test('a concurrent run is refused without changing bd state', async () => {
  save([child(1, 'pause')])
  const first = startRun()
  try {
    await waitForPause()
    const before = calls().length
    const lock = readFileSync(join(repository, '.git/simmer-tmp/epic.lock'), 'utf8')
    expect(run()).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `simmer run epic is already running (pid ${lock})\n`
    })
    expect(calls()).toHaveLength(before)
    writeFileSync(join(directory, 'resume'), '')
    const result = await first.completion
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  } finally {
    first.kill()
    await first.completion
  }
}, 15000)

test('status prints bd categories, assignees, lease states, and current deferrals', () => {
  save(
    [
      { ...child(1), status: 'closed' },
      { ...child(2), status: 'blocked' },
      {
        ...child(3),
        status: 'in_progress',
        assignee: 'worker',
        lease_expires_at: '2000-01-01T00:00:00Z'
      },
      child(4),
      { ...child(5), waiting: true },
      {
        ...child(6),
        status: 'in_progress',
        assignee: 'active-worker',
        lease_expires_at: '2999-01-01T00:00:00Z'
      },
      { ...child(7), status: 'in_progress', assignee: 'unknown-worker' }
    ],
    'simmer: deferred epic.1 simmer/old shared.txt\nsimmer: landed epic.1\n' +
      'simmer: deferred epic.2 simmer/pending primary is busy\n'
  )
  const expected = {
    epic: 'epic',
    counts: { closed: 1, blocked: 1, inProgress: 3, ready: 1, waiting: 1, deferred: 1 },
    closed: ['epic.1'],
    blocked: ['epic.2'],
    inProgress: [
      {
        id: 'epic.3',
        assignee: 'worker',
        lease: 'expired',
        leaseExpiresAt: '2000-01-01T00:00:00Z'
      },
      {
        id: 'epic.6',
        assignee: 'active-worker',
        lease: 'active',
        leaseExpiresAt: '2999-01-01T00:00:00Z'
      },
      { id: 'epic.7', assignee: 'unknown-worker', lease: 'unknown' }
    ],
    ready: ['epic.4'],
    waiting: ['epic.5'],
    deferred: [{ id: 'epic.2', branch: 'simmer/pending', reason: 'primary is busy' }]
  }
  const json = run(['status', 'epic', '--json'])
  expect(json.exitCode).toBe(0)
  expect(json.stderr).toBe('')
  expect(JSON.parse(json.stdout)).toEqual(expected)
  expect(json.stdout.split('\n')).toHaveLength(2)
  expect(run(['status', 'epic'])).toEqual({
    exitCode: 0,
    stderr: '',
    stdout:
      'epic\n' +
      'Closed: 1 epic.1\nBlocked: 1 epic.2\n' +
      'In progress: 3 epic.3 (assignee: worker, lease: expired), ' +
      'epic.6 (assignee: active-worker, lease: active), ' +
      'epic.7 (assignee: unknown-worker, lease: unknown)\n' +
      'Ready: 1 epic.4\nWaiting on dependencies: 1 epic.5\n' +
      'Deferred landings: 1 epic.2 (simmer/pending: primary is busy)\n'
  })
  expect(calls().every((call) => ['show', 'list'].includes(call.arguments[0] ?? ''))).toBe(true)
})

test('landing retries after the next child clears an overlapping primary change', () => {
  save([child(1, 'overlap'), child(2, 'clear-overlap')])
  writeFileSync(join(repository, 'shared.txt'), 'local change\n')
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  const output = events(result.stdout)
  expect(output.filter((event) => event.event === 'deferred').map((event) => event.id)).toEqual([
    'epic.1',
    'epic.1'
  ])
  expect(output.filter((event) => event.event === 'landed').map((event) => event.id)).toEqual([
    'epic.2',
    'epic.1'
  ])
  expect(readFileSync(join(repository, 'shared.txt'), 'utf8')).toBe('epic.1\n')
  expect(git(['show', 'main:epic.2.txt'])).toBe('epic.2')
  expect(JSON.parse(run(['status', 'epic', '--json']).stdout).deferred).toEqual([])
})

test('deferral survives a new command and lands when the overlap is removed', () => {
  save([child(1, 'overlap')])
  writeFileSync(join(repository, 'shared.txt'), 'local change\n')
  const first = run()
  expect(first.exitCode).toBe(4)
  const deferred = events(first.stdout).at(-1)?.deferred
  expect(deferred).toEqual([
    {
      id: 'epic.1',
      branch: expect.stringMatching(/^simmer\/epic-child-/),
      reason: 'shared.txt',
      verified: expect.stringMatching(/^[a-f0-9]{40}$/)
    }
  ])
  expect(state()[0]?.notes).toContain('simmer: deferred epic.1 ')
  expect(run(['run', 'epic']).stdout).toContain(': shared.txt\n')
  writeFileSync(join(repository, 'shared.txt'), 'initial\n')
  const resumed = run()
  expect(resumed.exitCode).toBe(0)
  expect(events(resumed.stdout).filter((event) => event.event === 'claimed')).toEqual([])
  expect(state()[0]?.notes).toContain('simmer: landed epic.1\n')
  expect(JSON.parse(run(['status', 'epic', '--json']).stdout).deferred).toEqual([])
  expect(readFileSync(join(repository, 'shared.txt'), 'utf8')).toBe('epic.1\n')
})

test('a lost claim does not stop the next child', () => {
  save([child(1, 'lost'), child(2)])
  const result = run()
  expect(result.exitCode).toBe(4)
  expect(events(result.stdout).at(-1)).toMatchObject({
    event: 'run-finished',
    epic: 'epic',
    counts: { done: 1, blocked: 0, lost: 1, errors: 0, deferred: 0 },
    exitCode: 4,
    deferred: []
  })
  expect(git(['show', 'main:epic.2.txt'])).toBe('epic.2')
})

test('three claims lost during the pipeline do not trigger the fatal error limit', () => {
  save([child(1, 'lose-owner'), child(2, 'lose-owner'), child(3, 'lose-owner'), child(4)])
  const result = run()
  expect(result.exitCode).toBe(4)
  expect(result.stderr).toBe('')
  expect(events(result.stdout).at(-1)).toMatchObject({
    event: 'run-finished',
    epic: 'epic',
    counts: { done: 1, blocked: 0, lost: 3, errors: 0, deferred: 0 },
    exitCode: 4,
    deferred: []
  })
  expect(git(['show', 'main:epic.4.txt'])).toBe('epic.4')
  expect(
    state()
      .slice(1, 4)
      .map((issue) => issue.assignee)
  ).toEqual(['another-worker', 'another-worker', 'another-worker'])
})

test('an unexpected child error is recorded and the next ready child lands', () => {
  save([child(1, 'error'), child(2)])
  const result = run()
  expect(result.exitCode).toBe(4)
  expect(git(['show', 'main:epic.2.txt'])).toBe('epic.2')
  expect(events(result.stdout).filter((event) => event.event === 'child-error')).toEqual([
    {
      event: 'child-error',
      epic: 'epic',
      id: 'epic.1',
      reason: 'bd update failed (exit 1): database unavailable'
    }
  ])
  expect(state()[0]?.notes).toContain('"outcome":"error"')
  expect(state()[1]?.status).toBe('open')
  expect(
    calls().filter((call) => call.arguments.includes('--claim') && call.arguments[1] === 'epic.1')
  ).toHaveLength(1)
})

test('the same error for three consecutive children stops with a clear message', () => {
  save([child(1, 'error'), child(2, 'error'), child(3, 'error'), child(4)])
  const result = run()
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(
    'Unexpected errors occurred for 3 consecutive children: ' +
      'bd update failed (exit 1): database unavailable\n'
  )
  expect(
    events(result.stdout)
      .filter((event) => event.event === 'child-error')
      .map((event) => event.id)
  ).toEqual(['epic.1', 'epic.2', 'epic.3'])
  expect(state()[4]?.status).toBe('open')
  expect(existsSync(join(repository, '.git/simmer-tmp/epic.lock'))).toBe(false)
})

test('a successful child resets the repeated error counter', () => {
  save([child(1, 'error'), child(2), child(3, 'error'), child(4, 'error'), child(5)])
  const result = run()
  expect(result.exitCode).toBe(4)
  expect(result.stderr).toBe('')
  expect(git(['show', 'main:epic.5.txt'])).toBe('epic.5')
})

test.each([true, false])(
  'a closed child interrupted before verification resumes, gate passes: %j',
  async (passes) => {
    save([child(1, 'closed-pause'), ...(passes ? [child(2, 'needs-first')] : [])])
    if (!passes) {
      writeFileSync(
        join(repository, 'simmer.json'),
        JSON.stringify({
          harness: 'codex',
          gate: 'exit 7',
          push: false
        })
      )
    }
    const first = startRun()
    try {
      await waitForPause()
      expect(state()[1]?.status).toBe('closed')
      first.kill()
      await first.completion
      writeFileSync(join(directory, 'resume'), '')
      const resumed = run()
      expect(resumed.exitCode).toBe(passes ? 0 : 4)
      expect(resumed.stderr).toBe('')
      const output = events(resumed.stdout)
      expect(output.filter((event) => event.event === 'claimed').map((event) => event.id)).toEqual(
        passes ? ['epic.2'] : ['epic.1']
      )
      if (passes) {
        expect(git(['show', 'main:epic.1.txt'])).toBe('epic.1')
        expect(output.filter((event) => event.event === 'landed').map((event) => event.id)).toEqual(
          ['epic.1', 'epic.2']
        )
        expect(git(['show', 'main:epic.2.txt'])).toBe('epic.2')
      } else {
        expect(git(['log', '-1', '--format=%s', 'main'])).toBe('initial')
        const status = JSON.parse(run(['status', 'epic', '--json']).stdout)
        expect(status.deferred).toEqual([])
        expect(status.blocked).toEqual(['epic.1'])
        expect(
          output.filter((event) => event.event === 'attempt-started').map((event) => event.attempt)
        ).toEqual([2])
      }
    } finally {
      first.kill()
      await first.completion
    }
  },
  15000
)

test('an unintegrated deferred branch lands after its old checkout was removed', () => {
  const checkout = join(directory, 'old-checkout')
  git(['branch', 'simmer/epic'])
  git(['worktree', 'add', '-qb', 'simmer/pending', checkout])
  writeFileSync(join(checkout, 'pending.txt'), 'pending work\n')
  git(['add', 'pending.txt'], checkout)
  git(['commit', '-qm', 'pending work'], checkout)
  git(['worktree', 'remove', checkout])
  save(
    [{ ...child(1), status: 'closed' }],
    'simmer: deferred epic.1 simmer/pending Run worktree is busy\n'
  )
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(git(['show', 'main:pending.txt'])).toBe('pending work')
  expect(JSON.parse(run(['status', 'epic', '--json']).stdout).deferred).toEqual([])
})

test('landing completed before its note survives a crash after branch cleanup', async () => {
  save([child(1)])
  writeFileSync(join(directory, 'pause-landed'), '')
  const first = startRun()
  try {
    await waitForPause()
    expect(git(['branch', '--list', 'simmer/epic-child-*'])).toBe('')
    expect(git(['show', 'main:epic.1.txt'])).toBe('epic.1')
    first.kill()
    await first.completion
    rmSync(join(directory, 'pause-landed'))
    const resumed = run()
    expect(resumed.exitCode).toBe(0)
    expect(resumed.stderr).toBe('')
    expect(events(resumed.stdout).filter((event) => event.event === 'claimed')).toEqual([])
    expect(JSON.parse(run(['status', 'epic', '--json']).stdout).deferred).toEqual([])
  } finally {
    first.kill()
    await first.completion
  }
}, 15000)

test('a failed recovery gate gets one fresh worker which fixes it and lands', async () => {
  save([child(1, 'closed-pause')])
  binary(
    'recovery-gate',
    "process.exit((await Bun.file('epic.1.txt').text()).includes('repaired') ? 0 : 7)"
  )
  writeFileSync(
    join(repository, 'simmer.json'),
    JSON.stringify({
      harness: 'codex',
      gate: 'recovery-gate',
      push: false
    })
  )
  const first = startRun()
  try {
    await waitForPause()
    first.kill()
    await first.completion
    writeFileSync(join(directory, 'resume'), '')
    const resumed = run()
    expect(resumed.exitCode).toBe(0)
    expect(resumed.stderr).toBe('')
    expect(
      events(resumed.stdout)
        .filter((event) => event.event === 'attempt-started')
        .map((event) => event.attempt)
    ).toEqual([2])
    expect(git(['show', 'main:epic.1.txt'])).toBe('epic.1 repaired')
    expect(state()[1]?.status).toBe('closed')
  } finally {
    first.kill()
    await first.completion
  }
}, 15000)

test('an incomplete lock is replaced, and an empty epic emits start and finish events', () => {
  save([])
  mkdirSync(join(repository, '.git/simmer-tmp'))
  writeFileSync(join(repository, '.git/simmer-tmp/epic.lock'), '')
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(events(result.stdout)).toEqual([
    { event: 'run-started', epic: 'epic' },
    {
      event: 'run-finished',
      epic: 'epic',
      counts: { done: 0, blocked: 0, lost: 0, errors: 0, deferred: 0 },
      exitCode: 0,
      deferred: []
    }
  ])
})

test('status needs neither git nor a valid simmer config', () => {
  writeFileSync(join(repository, 'simmer.json'), '{')
  binary('git', 'process.exit(99)')
  const result = run(['status', 'epic', '--json'])
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout).ready).toEqual(['epic.1', 'epic.2', 'epic.3'])
})

test('a fatal bd read failure emits run-finished and releases the lock', () => {
  binary(
    'bd',
    "if (process.argv[2] === 'show') { process.stderr.write('database unavailable'); " +
      "process.exit(1) } process.stdout.write('[]')"
  )
  const result = run()
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe('bd show failed (exit 1): database unavailable\n')
  expect(events(result.stdout).at(-1)).toEqual({
    event: 'run-finished',
    epic: 'epic',
    exitCode: 1,
    reason: 'bd show failed (exit 1): database unavailable',
    counts: { done: 0, blocked: 0, lost: 0, errors: 0, deferred: 0 }
  })
  expect(existsSync(join(repository, '.git/simmer-tmp/epic.lock'))).toBe(false)
})

test('only one concurrent process takes over a stale lock', async () => {
  save([child(1, 'pause')])
  mkdirSync(join(repository, '.git/simmer-tmp'))
  writeFileSync(join(repository, '.git/simmer-tmp/epic.lock'), '')
  const first = startRun()
  const second = startRun()
  try {
    await waitForPause()
    writeFileSync(join(directory, 'resume'), '')
    const results = await Promise.all([first.completion, second.completion])
    expect(results.map((result) => result.exitCode).sort()).toEqual([0, 1])
    expect(results.find((result) => result.exitCode === 1)?.stdout).toBe('')
    expect(results.find((result) => result.exitCode === 1)?.stderr).toMatch(
      /^simmer run epic is already running \(pid \d+\)\n$/
    )
    expect(calls().filter((call) => call.arguments.includes('--claim'))).toHaveLength(1)
    expect(state()[1]?.status).toBe('closed')
  } finally {
    first.kill()
    second.kill()
    await Promise.all([first.completion, second.completion])
  }
}, 15000)

test('an interrupted stale-lock takeover does not prevent a later run', () => {
  save([])
  mkdirSync(join(repository, '.git/simmer-tmp'))
  const lock = join(repository, '.git/simmer-tmp/epic.lock')
  writeFileSync(lock, '')
  writeFileSync(`${lock}.reclaim-${statSync(lock).ino}`, '')
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(existsSync(lock)).toBe(false)
})

test('run recovers an unassigned in-progress child without a lease', () => {
  save([{ ...child(1), status: 'in_progress' }])
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(state()[1]?.status).toBe('closed')
  expect(git(['show', 'main:epic.1.txt'])).toBe('epic.1')
})

test('a rerun before lease expiry exits 4 and explains when to resume', () => {
  save([
    {
      ...child(1),
      status: 'in_progress',
      assignee: 'dead-worker',
      lease_expires_at: '2999-01-01T00:00:00Z'
    }
  ])
  const result = run(['run', 'epic'])
  expect(result.exitCode).toBe(4)
  expect(result.stdout).toContain('epic.1: in progress, lease expires 2999-01-01T00:00:00Z\n')
  expect(result.stdout).toContain('Rerun after lease expiry to resume these children.\n')
  expect(calls().filter((call) => call.arguments.includes('--claim'))).toEqual([])
})

test('three different unexpected errors stop the run without blocking children', () => {
  save([child(1), child(2), child(3), child(4)])
  const realGit = Bun.which('git')
  if (!realGit) throw new Error('Missing Git')
  binary(
    'git',
    `
const argumentsList = process.argv.slice(2)
if (argumentsList.includes('--track')) {
  process.stderr.write('Cannot create ' + argumentsList.join(' '))
  process.exit(42)
}
const result = Bun.spawnSync([${JSON.stringify(realGit)}, ...argumentsList],
  { stdout: 'inherit', stderr: 'inherit' })
process.exit(result.exitCode)
`
  )
  const result = run()
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('Unexpected errors occurred for 3 consecutive children:')
  expect(
    events(result.stdout)
      .filter((event) => event.event === 'child-error')
      .map((event) => event.id)
  ).toEqual(['epic.1', 'epic.2', 'epic.3'])
  expect(
    state()
      .slice(1)
      .map((issue) => [issue.status, issue.assignee])
  ).toEqual([
    ['open', ''],
    ['open', ''],
    ['open', ''],
    ['open', '']
  ])
  expect(state()[0]?.notes.split('"outcome":"error"')).toHaveLength(4)
})

test('verified deferred work retries landing without running a flaky gate again', () => {
  save([child(1, 'overlap')])
  writeFileSync(join(repository, 'shared.txt'), 'local change\n')
  binary(
    'flaky-gate',
    `
import { appendFileSync, existsSync } from 'node:fs'
const marker = ${JSON.stringify(join(directory, 'gate-calls'))}
const passed = !existsSync(marker)
appendFileSync(marker, 'gate\\n')
process.exit(passed ? 0 : 7)
`
  )
  writeFileSync(
    join(repository, 'simmer.json'),
    JSON.stringify({ harness: 'codex', gate: 'flaky-gate' })
  )
  expect(run().exitCode).toBe(4)
  expect(readFileSync(join(directory, 'gate-calls'), 'utf8')).toBe('gate\n')
  expect(state()[1]?.status).toBe('closed')
  writeFileSync(join(repository, 'shared.txt'), 'initial\n')
  expect(run().exitCode).toBe(0)
  expect(readFileSync(join(directory, 'gate-calls'), 'utf8')).toBe('gate\n')
  expect(git(['show', 'main:shared.txt'])).toBe('epic.1')
})

test('a missing deferred branch is dropped with a status warning', () => {
  save([{ ...child(1), status: 'closed' }], 'simmer: deferred epic.1 simmer/missing shared.txt\n')
  const result = run()
  expect(result.exitCode).toBe(0)
  expect(state()[0]?.notes).toContain('simmer: dropped epic.1 Branch simmer/missing is missing\n')
  expect(JSON.parse(run(['status', 'epic', '--json']).stdout).deferred).toEqual([])
  expect(run(['status', 'epic']).stdout).toContain(
    'Warning: dropped epic.1: Branch simmer/missing is missing\n'
  )
  expect(calls().filter((call) => call.input.includes('simmer: dropped'))).toHaveLength(1)
})

test('a missing lock does not hide the real run error', () => {
  binary(
    'bd',
    `
import { rmSync } from 'node:fs'
if (process.argv[2] === 'show') {
  rmSync(${JSON.stringify(join(repository, '.git/simmer-tmp/epic.lock'))}, { force: true })
  process.stderr.write('database unavailable')
  process.exit(1)
}
process.stdout.write('[]')
`
  )
  expect(run().stderr).toBe('bd show failed (exit 1): database unavailable\n')
})

test.each(['run', 'child'])(
  '%s handles SIGINT and SIGTERM, kills descendants, and keeps its lease',
  async (command) => {
    for (const [signal, exitCode] of [
      ['SIGINT', 130],
      ['SIGTERM', 143]
    ] satisfies [NodeJS.Signals, number][]) {
      save([child(1)])
      rmSync(join(directory, 'paused'), { force: true })
      binary(
        'codex',
        `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const descendant = spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(() => {}, 1000)'],
  { detached: true, stdio: 'ignore' })
writeFileSync(${JSON.stringify(join(directory, 'descendant.pid'))}, String(descendant.pid))
writeFileSync(${JSON.stringify(join(directory, 'paused'))}, String(process.pid))
setInterval(() => {}, 1000)
`
      )
      const first = startRun([command, command === 'run' ? 'epic' : 'epic.1', '--json'])
      try {
        await waitForPause()
        const workerId = Number(readFileSync(join(directory, 'paused'), 'utf8'))
        const descendantId = Number(readFileSync(join(directory, 'descendant.pid'), 'utf8'))
        first.signal(signal)
        const result = await first.completion
        expect(result.exitCode).toBe(exitCode)
        if (command === 'run') expect(events(result.stdout).at(-1)?.exitCode).toBe(exitCode)
        expect(() => process.kill(workerId, 0)).toThrow()
        const descendantStat = `/proc/${descendantId}/stat`
        expect(
          existsSync(descendantStat)
            ? readFileSync(descendantStat, 'utf8').split(') ')[1]?.startsWith('Z ')
            : true
        ).toBe(true)
        expect(state()[1]?.status).toBe('in_progress')
        expect(state()[1]?.lease_expires_at).toBeDefined()
        expect(existsSync(join(repository, '.git/simmer-tmp/epic.lock'))).toBe(false)
      } finally {
        first.kill()
        await first.completion
        for (const marker of ['paused', 'descendant.pid']) {
          const processId = Number(readFileSync(join(directory, marker), 'utf8'))
          try {
            process.kill(processId, 'SIGKILL')
          } catch {}
        }
      }
    }
  },
  15000
)

test('an interrupted child passes verification once while its landing stays deferred', () => {
  const checkout = join(directory, 'interrupted')
  const start = git(['rev-parse', 'HEAD'])
  git(['branch', 'simmer/epic'])
  git(['worktree', 'add', '-qb', 'simmer/interrupted', checkout])
  writeFileSync(join(checkout, 'shared.txt'), 'checked work\n')
  git(['add', 'shared.txt'], checkout)
  git(['commit', '-qm', 'checked work'], checkout)
  save([{ ...child(1), status: 'closed' }], `simmer: working epic.1 simmer/interrupted ${start}\n`)
  writeFileSync(join(repository, 'shared.txt'), 'local change\n')
  binary(
    'flaky-gate',
    `
import { appendFileSync, existsSync } from 'node:fs'
const marker = ${JSON.stringify(join(directory, 'gate-calls'))}
const passed = !existsSync(marker)
appendFileSync(marker, 'gate\\n')
process.exit(passed ? 0 : 7)
`
  )
  writeFileSync(
    join(repository, 'simmer.json'),
    JSON.stringify({ harness: 'codex', gate: 'flaky-gate' })
  )
  const result = run()
  expect(result.exitCode).toBe(4)
  expect(result.stderr).toBe('')
  expect(readFileSync(join(directory, 'gate-calls'), 'utf8')).toBe('gate\n')
  expect(events(result.stdout).filter((event) => event.event === 'attempt-started')).toEqual([])
  expect(state()[1]?.status).toBe('closed')
  writeFileSync(join(repository, 'shared.txt'), 'initial\n')
  expect(run().exitCode).toBe(0)
  expect(readFileSync(join(directory, 'gate-calls'), 'utf8')).toBe('gate\n')
  expect(git(['show', 'main:shared.txt'])).toBe('checked work')
})

test('a crash after reopening a red gate leaves a lease that a rerun can reclaim', async () => {
  save([child(1)])
  binary(
    'retry-gate',
    `
import { existsSync, writeFileSync } from 'node:fs'
const marker = ${JSON.stringify(join(directory, 'gate-calls'))}
const passed = existsSync(marker)
writeFileSync(marker, 'gate')
process.exit(passed ? 0 : 7)
`
  )
  writeFileSync(
    join(repository, 'simmer.json'),
    JSON.stringify({ harness: 'codex', gate: 'retry-gate' })
  )
  writeFileSync(join(directory, 'pause-reclaim'), '')
  const first = startRun()
  try {
    await waitForPause()
    const claimed = state()[1]
    if (!claimed) throw new Error('Missing child')
    expect(claimed.status).toBe('in_progress')
    expect(Date.parse(claimed.lease_expires_at ?? '') > Date.now()).toBe(true)
    expect(calls().filter((call) => call.arguments.includes('--claim'))).toHaveLength(2)
    first.kill()
    await first.completion
    rmSync(join(directory, 'pause-reclaim'), { force: true })
    save([{ ...claimed, lease_expires_at: '2000-01-01T00:00:00Z' }], state()[0]?.notes)
    const result = run()
    expect(result.exitCode).toBe(0)
    expect(state()[1]?.status).toBe('closed')
    expect(git(['show', 'main:epic.1.txt'])).toBe('epic.1')
  } finally {
    first.kill()
    await first.completion
  }
}, 15000)

test.each([false, true])(
  'a persisted verified SHA resumes only landing, branch changed: %j',
  (changed) => {
    const checkout = join(directory, 'verified')
    const start = git(['rev-parse', 'HEAD'])
    git(['branch', 'simmer/epic'])
    git(['worktree', 'add', '-qb', 'simmer/verified', checkout])
    writeFileSync(join(checkout, 'checked.txt'), 'checked work\n')
    git(['add', 'checked.txt'], checkout)
    git(['commit', '-qm', 'checked work'], checkout)
    const checked = git(['rev-parse', 'HEAD'], checkout)
    save(
      [{ ...child(1), status: 'closed' }],
      `simmer: working epic.1 simmer/verified ${start}\n` +
        `simmer: verified epic.1 simmer/verified ${checked}\n`
    )
    if (changed) {
      writeFileSync(join(checkout, 'unchecked.txt'), 'unchecked work\n')
      git(['add', 'unchecked.txt'], checkout)
      git(['commit', '-qm', 'unchecked work'], checkout)
    }
    binary(
      'forbidden-gate',
      `
await Bun.write(${JSON.stringify(join(directory, 'gate-calls'))}, 'unexpected')
process.exit(7)
`
    )
    writeFileSync(
      join(repository, 'simmer.json'),
      JSON.stringify({ harness: 'codex', gate: 'forbidden-gate' })
    )
    const result = run()
    expect(result.exitCode).toBe(changed ? 4 : 0)
    expect(existsSync(join(directory, 'gate-calls'))).toBe(false)
    expect(events(result.stdout).filter((event) => event.event === 'attempt-started')).toEqual([])
    expect(state()[1]?.status).toBe('closed')
    if (changed) {
      expect(git(['log', '-1', '--format=%s', 'main'])).toBe('initial')
      expect(state()[0]?.notes).toContain('Branch simmer/verified changed after verification')
    } else {
      expect(git(['show', 'main:checked.txt'])).toBe('checked work')
    }
  }
)

test('a lost claim does not reset the unexpected error count', () => {
  save([child(1, 'error'), child(2, 'lost'), child(3, 'error'), child(4, 'error'), child(5)])
  const result = run()
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('Unexpected errors occurred for 3 consecutive children:')
  expect(
    events(result.stdout)
      .filter((event) => event.event === 'child-error')
      .map((event) => event.id)
  ).toEqual(['epic.1', 'epic.3', 'epic.4'])
  expect(state()[5]?.status).toBe('open')
})

test.each(['retry', 'error'])(
  'a crash between reopen and %s claim cleanup recovers the stale open assignee',
  async (mode) => {
    save([child(1)])
    if (mode === 'retry') {
      writeFileSync(
        join(repository, 'simmer.json'),
        JSON.stringify({ harness: 'codex', gate: 'exit 7' })
      )
    } else {
      const realGit = Bun.which('git')
      if (!realGit) throw new Error('Missing Git')
      binary(
        'git',
        `
const argumentsList = process.argv.slice(2)
const state = await Bun.file(${JSON.stringify(join(directory, 'state.json'))}).json()
if (argumentsList[4] === 'rev-list' && state[1].status === 'closed') {
  process.stderr.write('injected verification failure')
  process.exit(42)
}
const result = Bun.spawnSync([${JSON.stringify(realGit)}, ...argumentsList],
  { stdout: 'inherit', stderr: 'inherit' })
process.exit(result.exitCode)
`
      )
    }
    writeFileSync(join(directory, 'pause-reopen'), '')
    const first = startRun()
    try {
      await waitForPause()
      expect(state()[1]?.status).toBe('open')
      expect(state()[1]?.assignee).not.toBe('')
      expect(state()[1]?.lease_expires_at).toBeUndefined()
      first.kill()
      await first.completion
      rmSync(join(directory, 'pause-reopen'))
      rmSync(join(directory, 'bin/git'), { force: true })
      writeFileSync(
        join(repository, 'simmer.json'),
        JSON.stringify({ harness: 'codex', gate: 'true' })
      )
      const result = run()
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(state()[1]?.status).toBe('closed')
      expect(git(['show', 'main:epic.1.txt'])).toBe('epic.1')
      expect(events(result.stdout).at(-1)?.counts).toEqual({
        done: 1,
        blocked: 0,
        lost: 0,
        errors: 0,
        deferred: 0
      })
    } finally {
      first.kill()
      await first.completion
    }
  },
  15000
)

test.each(['run', 'child'])(
  '%s lets an in-flight bd claim finish after a signal before exiting',
  async (command) => {
    for (const [signal, exitCode] of [
      ['SIGINT', 130],
      ['SIGTERM', 143]
    ] satisfies [NodeJS.Signals, number][]) {
      save([child(1)])
      rmSync(join(directory, 'paused'), { force: true })
      rmSync(join(directory, 'resume'), { force: true })
      writeFileSync(join(directory, 'pause-claim'), '')
      const first = startRun([command, command === 'run' ? 'epic' : 'epic.1', '--json'])
      let finished = false
      void first.completion.then(() => {
        finished = true
      })
      try {
        await waitForPause()
        first.signal(signal)
        await Bun.sleep(80)
        expect(finished).toBe(false)
        writeFileSync(join(directory, 'resume'), '')
        const result = await first.completion
        expect(result.exitCode).toBe(exitCode)
        expect(result.stderr).toBe(`Interrupted by ${signal}\n`)
        expect(state()[1]?.status).toBe('in_progress')
        expect(state()[1]?.lease_expires_at).toBeDefined()
        expect(events(result.stdout).filter((event) => event.event === 'attempt-started')).toEqual(
          []
        )
        expect(existsSync(join(repository, '.git/simmer-tmp/epic.lock'))).toBe(false)
      } finally {
        first.kill()
        await first.completion
      }
    }
  },
  15000
)

test('a landing note failure keeps integrated work closed and deferred until landing succeeds', () => {
  save([child(1, 'overlap')])
  writeFileSync(join(repository, 'shared.txt'), 'local change\n')
  writeFileSync(join(directory, 'fail-landing-note'), '')
  const first = run()
  expect(first.exitCode).toBe(4)
  expect(state()[1]?.status).toBe('closed')
  expect(state()[0]?.notes).not.toContain('simmer: stopped epic.1')
  expect(calls().filter((call) => ['reopen', 'unclaim'].includes(call.arguments[0] ?? ''))).toEqual(
    []
  )
  expect(git(['show', 'simmer/epic:shared.txt'])).toBe('epic.1')
  expect(JSON.parse(run(['status', 'epic', '--json']).stdout).counts.deferred).toBe(1)
  writeFileSync(join(repository, 'shared.txt'), 'initial\n')
  const resumed = run()
  expect(resumed.exitCode).toBe(0)
  expect(events(resumed.stdout).filter((event) => event.event === 'attempt-started')).toEqual([])
  expect(git(['show', 'main:shared.txt'])).toBe('epic.1')
  expect(state()[1]?.status).toBe('closed')
})

test.each(['run', 'base'])(
  'a stale verified SHA already on %s lands only the run branch',
  (target) => {
    const checkout = join(directory, 'verified')
    git(['branch', 'simmer/epic'])
    git(['worktree', 'add', '-qb', 'simmer/verified', checkout])
    writeFileSync(join(checkout, 'checked.txt'), 'checked work\n')
    git(['add', 'checked.txt'], checkout)
    git(['commit', '-qm', 'checked work'], checkout)
    const checked = git(['rev-parse', 'HEAD'], checkout)
    if (target === 'run') git(['update-ref', 'refs/heads/simmer/epic', checked])
    else git(['merge', '--ff-only', checked])
    writeFileSync(join(checkout, 'unchecked.txt'), 'unchecked work\n')
    git(['add', 'unchecked.txt'], checkout)
    git(['commit', '-qm', 'unchecked work'], checkout)
    save(
      [{ ...child(1), status: 'closed' }],
      `simmer: verified epic.1 simmer/verified ${checked}\n`
    )
    binary(
      'forbidden-gate',
      `
await Bun.write(${JSON.stringify(join(directory, 'gate-calls'))}, 'unexpected')
process.exit(7)
`
    )
    writeFileSync(
      join(repository, 'simmer.json'),
      JSON.stringify({ harness: 'codex', gate: 'forbidden-gate' })
    )
    const result = run()
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(existsSync(join(directory, 'gate-calls'))).toBe(false)
    expect(events(result.stdout).filter((event) => event.event === 'attempt-started')).toEqual([])
    expect(git(['show', 'main:checked.txt'])).toBe('checked work')
    expect(git(['ls-tree', '--name-only', 'main', 'unchecked.txt'])).toBe('')
    expect(state()[1]?.status).toBe('closed')
    expect(JSON.parse(run(['status', 'epic', '--json']).stdout).deferred).toEqual([])
  }
)

test.each([false, true])(
  'a missing child branch lands the run branch before dropping, overlap: %j',
  (overlap) => {
    const checkout = join(directory, 'run-branch')
    git(['worktree', 'add', '-qb', 'simmer/epic', checkout])
    writeFileSync(join(checkout, 'shared.txt'), 'integrated work\n')
    git(['add', 'shared.txt'], checkout)
    git(['commit', '-qm', 'integrated work'], checkout)
    git(['worktree', 'remove', checkout])
    save(
      [{ ...child(1), status: 'closed' }],
      'simmer: deferred epic.1 simmer/missing Landing was interrupted\n'
    )
    if (overlap) writeFileSync(join(repository, 'shared.txt'), 'local change\n')
    const result = run()
    expect(result.exitCode).toBe(overlap ? 4 : 0)
    if (overlap) {
      expect(state()[0]?.notes).not.toContain('simmer: dropped')
      expect(git(['show', 'main:shared.txt'])).toBe('initial')
      expect(JSON.parse(run(['status', 'epic', '--json']).stdout).counts.deferred).toBe(1)
      writeFileSync(join(repository, 'shared.txt'), 'initial\n')
      expect(run().exitCode).toBe(0)
    }
    expect(git(['show', 'main:shared.txt'])).toBe('integrated work')
    expect(state()[0]?.notes).toContain('simmer: dropped epic.1 Branch simmer/missing is missing\n')
    expect(JSON.parse(run(['status', 'epic', '--json']).stdout).deferred).toEqual([])
    expect(calls().filter((call) => call.input.includes('simmer: dropped'))).toHaveLength(1)
  }
)

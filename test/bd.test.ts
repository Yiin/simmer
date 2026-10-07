import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bd, BdError } from '../src/bd'

type Step = {
  arguments: string[]
  stdout?: string
  stderr?: string
  exitCode?: number
  input?: string
}

let directory: string
let originalPath: string | undefined
let adapter: Bd

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer bd-test-')
  originalPath = process.env.PATH
  process.env.PATH = `${directory}:${originalPath ?? ''}`
  adapter = new Bd({ cwd: directory, actor: 'worker 7' })
  writeFileSync(join(directory, 'steps.json'), '[]')
  writeFileSync(
    join(directory, 'bd'),
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
const steps = JSON.parse(readFileSync('steps.json', 'utf8'))
const step = steps.shift()
writeFileSync('steps.json', JSON.stringify(steps))
const actual = process.argv.slice(2)
const input = readFileSync(0, 'utf8')
if (!step || JSON.stringify(actual) !== JSON.stringify(step.arguments) ||
    input !== (step.input ?? '')) {
  process.stderr.write('Unexpected bd call: ' + JSON.stringify({ actual, input }))
  process.exit(99)
}
process.stdout.write(step.stdout ?? '')
process.stderr.write(step.stderr ?? '')
process.exit(step.exitCode ?? 0)
`,
    { mode: 0o755 }
  )
})

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  try {
    expect(JSON.parse(readFileSync(join(directory, 'steps.json'), 'utf8'))).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function respond(...steps: Step[]) {
  writeFileSync(
    join(directory, 'steps.json'),
    JSON.stringify(
      steps.map((step) => ({
        ...step,
        arguments: [...step.arguments, '--json', '--actor', 'worker 7']
      }))
    )
  )
}

test('readyChildren reads all direct ready children with bd ready semantics', async () => {
  respond({
    arguments: ['list', '--parent', 'epic-1', '--ready', '--limit', '0'],
    stdout: `[
      {"id":"epic-1.2","title":"First","status":"open","description":"Do it",
       "acceptance_criteria":"Green gate","notes":"Prior attempt","priority":1,
       "parent":"epic-1","dependencies":[]},
      {"id":"epic-1.3","title":"Second","status":"open"}
    ]`
  })
  expect(await adapter.readyChildren('epic-1')).toEqual([
    {
      id: 'epic-1.2',
      title: 'First',
      status: 'open',
      description: 'Do it',
      acceptanceCriteria: 'Green gate',
      notes: 'Prior attempt'
    },
    {
      id: 'epic-1.3',
      title: 'Second',
      status: 'open',
      description: '',
      acceptanceCriteria: '',
      notes: ''
    }
  ])
})

test('readyChildren returns an empty array when no children are ready', async () => {
  respond({ arguments: ['list', '--parent', 'epic-1', '--ready', '--limit', '0'], stdout: '[]' })
  expect(await adapter.readyChildren('epic-1')).toEqual([])
})

test('children includes closed and blocked children without the default row limit', async () => {
  respond({
    arguments: ['list', '--parent', 'epic-1', '--all', '--limit', '0'],
    stdout: '[{"id":"epic-1.1","title":"Done","status":"closed"}]'
  })
  expect(await adapter.children('epic-1')).toEqual([
    {
      id: 'epic-1.1',
      title: 'Done',
      status: 'closed',
      description: '',
      acceptanceCriteria: '',
      notes: ''
    }
  ])
})

test('claim takes the atomic bd claim', async () => {
  respond({
    arguments: ['update', 'epic-1.2', '--claim'],
    stdout: '[{"id":"epic-1.2","title":"Child","status":"in_progress"}]'
  })
  expect(await adapter.claim('epic-1.2')).toEqual({ kind: 'claimed' })
})

test('claim returns lost when another actor already holds the child', async () => {
  respond({
    arguments: ['update', 'epic-1.2', '--claim'],
    exitCode: 1,
    stderr: 'Error updating epic-1.2: issue already claimed by worker 8\n'
  })
  expect(await adapter.claim('epic-1.2')).toEqual({ kind: 'lost' })
})

test('claim throws ordinary failures', async () => {
  respond({
    arguments: ['update', 'epic-1.2', '--claim'],
    exitCode: 1,
    stderr: 'database unavailable\n'
  })
  await expect(adapter.claim('epic-1.2')).rejects.toThrow(
    'bd update failed (exit 1): database unavailable'
  )
})

test('heartbeat renews the same issue each time the worker calls it', async () => {
  respond(
    {
      arguments: ['heartbeat', 'epic-1.2'],
      stdout: '{"id":"epic-1.2","status":"heartbeat","owner":"worker 7"}'
    },
    {
      arguments: ['heartbeat', 'epic-1.2'],
      stdout: '{"id":"epic-1.2","status":"heartbeat","owner":"worker 7"}'
    }
  )
  expect(await adapter.heartbeat('epic-1.2')).toBeUndefined()
  expect(await adapter.heartbeat('epic-1.2')).toBeUndefined()
})

test('heartbeat reports lost ownership to the worker', async () => {
  respond({ arguments: ['heartbeat', 'epic-1.2'], exitCode: 1, stderr: 'owned by worker 8' })
  try {
    await adapter.heartbeat('epic-1.2')
    throw new Error('Expected heartbeat failure')
  } catch (error) {
    expect(error).toBeInstanceOf(BdError)
    if (!(error instanceof BdError)) throw error
    expect(error.exitCode).toBe(1)
    expect(error.message).toBe('bd heartbeat failed (exit 1): owned by worker 8')
  }
})

test.each([
  { status: 'closed', expected: true },
  { status: 'open', expected: false },
  { status: 'in_progress', expected: false },
  { status: 'blocked', expected: false },
  { status: 'deferred', expected: false },
  { status: 'custom', expected: false }
])('isClosed detects $status from the show array', async ({ status, expected }) => {
  respond({
    arguments: ['show', 'epic-1.2'],
    stdout: JSON.stringify([{ id: 'epic-1.2', title: 'Child', status }])
  })
  expect(await adapter.isClosed('epic-1.2')).toBe(expected)
})

test('unclaim guards the actor and never forces release of another owner', async () => {
  respond({
    arguments: ['unclaim', 'epic-1.2', '--if-assignee', 'worker 7'],
    stdout: '[{"id":"epic-1.2","title":"Child","status":"open"}]'
  })
  expect(await adapter.unclaim('epic-1.2')).toBeUndefined()
})

test('unclaim reports an ownership mismatch', async () => {
  respond({
    arguments: ['unclaim', 'epic-1.2', '--if-assignee', 'worker 7'],
    exitCode: 1,
    stderr: 'current holder is worker 8'
  })
  await expect(adapter.unclaim('epic-1.2')).rejects.toThrow(
    'bd unclaim failed (exit 1): current holder is worker 8'
  )
})

test.each(['epic-1.2', 'epic-1'])('note appends exact text to %s through stdin', async (id) => {
  respond({
    arguments: ['note', id, '--stdin'],
    input: '--force\nGate failed: "quotes", $HOME, `command`, $(command)\n',
    stdout: '{"id":"epic-1","title":"Epic","status":"open"}'
  })
  expect(
    await adapter.note(id, '--force\nGate failed: "quotes", $HOME, `command`, $(command)\n')
  ).toBeUndefined()
})

test('reclaimExpired only reclaims in-progress children of the requested epic', async () => {
  respond(
    {
      arguments: ['list', '--parent', 'epic-1', '--all', '--limit', '0'],
      stdout: `[
        {"id":"epic-1.1","title":"Done","status":"closed"},
        {"id":"epic-1.2","title":"Running","status":"in_progress"},
        {"id":"epic-1.3","title":"Running too","status":"in_progress"},
        {"id":"epic-1.4","title":"Open","status":"open"}
      ]`
    },
    {
      arguments: ['reclaim', '--id', 'epic-1.2,epic-1.3', '--older-than', '0s'],
      stdout: '{"reclaimed":[],"count":0,"scoped":true}'
    }
  )
  expect(await adapter.reclaimExpired('epic-1')).toBeUndefined()
})

test('reclaimExpired never runs a global reclaim when the epic has no running children', async () => {
  respond({ arguments: ['list', '--parent', 'epic-1', '--all', '--limit', '0'], stdout: '[]' })
  expect(await adapter.reclaimExpired('epic-1')).toBeUndefined()
})

test.each([
  { output: '{', message: 'expected an issue array' },
  { output: '{}', message: 'expected an issue array' },
  { output: '[null]', message: 'issue must be an object' },
  { output: '[{"title":"Child","status":"open"}]', message: 'id must be a string' },
  { output: '[{"id":"epic-1.2","status":"open"}]', message: 'title must be a string' },
  { output: '[{"id":"epic-1.2","title":"Child","status":1}]', message: 'status must be a string' },
  {
    output: '[{"id":"epic-1.2","title":"Child","status":"open","notes":1}]',
    message: 'notes must be a string'
  }
])('readyChildren rejects invalid JSON: $message', async ({ output, message }) => {
  respond({ arguments: ['list', '--parent', 'epic-1', '--ready', '--limit', '0'], stdout: output })
  await expect(adapter.readyChildren('epic-1')).rejects.toThrow(`Invalid bd JSON: ${message}`)
})

test.each([
  '[]',
  '[{"id":"other-1","title":"Other","status":"closed"}]',
  '[{"id":"epic-1.2","title":"Child","status":"closed"},' +
    '{"id":"epic-1.3","title":"Other","status":"closed"}]'
])('show rejects a missing, different, or ambiguous issue', async (output) => {
  respond({ arguments: ['show', 'epic-1.2'], stdout: output })
  await expect(adapter.isClosed('epic-1.2')).rejects.toThrow(
    'Invalid bd JSON: expected issue epic-1.2'
  )
})

test('read failures keep exit code and stderr instead of parsing failed output', async () => {
  respond({ arguments: ['show', 'epic-1.2'], stdout: '{', stderr: 'not found', exitCode: 1 })
  await expect(adapter.show('epic-1.2')).rejects.toThrow('bd show failed (exit 1): not found')
})

test('failures use stdout when stderr is empty', async () => {
  respond({ arguments: ['show', 'epic-1.2'], stdout: '{"error":"offline"}', exitCode: 2 })
  await expect(adapter.show('epic-1.2')).rejects.toThrow(
    'bd show failed (exit 2): {"error":"offline"}'
  )
})

test.each(['', '--force', 'epic-1 extra', 'epic-1,other-1'])(
  'claim rejects unsafe ID %j',
  async (id) => {
    await expect(adapter.claim(id)).rejects.toThrow(`Invalid bd issue ID: ${id}`)
  }
)

test('an empty actor fails before starting bd', () => {
  expect(() => new Bd({ cwd: directory, actor: ' ' })).toThrow(
    'bd actor must be a non-empty string'
  )
})

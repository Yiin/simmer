import { afterEach, beforeEach, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config'

const projectRoot = join(import.meta.dir, '..')
const cliPath = join(projectRoot, 'src/cli.ts')
let directory: string

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer-test-')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function run(commandArguments: readonly string[], cwd = directory) {
  const result = Bun.spawnSync([process.execPath, cliPath, ...commandArguments], { cwd })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  }
}

function writeConfig(value: unknown) {
  writeFileSync(join(directory, 'simmer.json'), JSON.stringify(value))
}

test('bun run simmer --help lists each command', () => {
  const result = Bun.spawnSync([process.execPath, 'run', 'simmer', '--help'], {
    cwd: projectRoot
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toBe(`Usage: simmer <command> [options]

Commands:
  run <epic>                 Run ready children in order
  child <bead>               Run one child
  status <epic>              Show epic progress

Options:
  --harness claude|codex|pi   Select the worker harness
  --json                     Print JSON events
  --worktree <path>           Use an existing worktree (child)
  --no-land                  Skip landing (child)
  -h, --help                 Show help
  -v, --version              Show the package version
`)
})

test('version reads package.json', () => {
  mkdirSync(join(directory, 'src'))
  cpSync(cliPath, join(directory, 'src/cli.ts'))
  cpSync(join(projectRoot, 'src/config.ts'), join(directory, 'src/config.ts'))
  writeFileSync(join(directory, 'package.json'), '{"version":"9.8.7","type":"module"}')
  const result = Bun.spawnSync([process.execPath, 'src/cli.ts', '--version'], { cwd: directory })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toBe('9.8.7\n')
  expect(result.stderr.toString()).toBe('')
})

test('bun link installs a callable simmer binary', () => {
  const environment = {
    ...process.env,
    BUN_INSTALL: directory,
    BUN_TMPDIR: directory,
    BUN_INSTALL_CACHE_DIR: join(directory, 'cache'),
    PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}`
  }
  const linked = Bun.spawnSync([process.execPath, 'link'], {
    cwd: projectRoot,
    env: environment
  })
  expect(linked.exitCode).toBe(0)
  const result = Bun.spawnSync(['simmer', '--version'], { cwd: directory, env: environment })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toBe('0.1.0\n')
  expect(result.stderr.toString()).toBe('')
})

test('missing config uses the design defaults', async () => {
  expect(await loadConfig(directory)).toEqual({
    base: 'main',
    gate: 'bun run typecheck && bun run test',
    push: false,
    harness: 'claude',
    harnessPaths: { claude: 'claude', codex: 'codex', pi: 'pi' },
    watchdogMinutes: 20,
    models: { planner: 'opus', implementer: 'sonnet', reviewer: 'opus', tester: 'opus' }
  })
})

test('config loads every supported field', async () => {
  writeConfig({
    base: 'develop',
    gate: 'bun test',
    push: true,
    harness: 'pi',
    harnessPaths: { claude: '/bin/claude', codex: '/bin/codex', pi: '/bin/pi' },
    watchdogMinutes: 0.5,
    models: { planner: 'plan', implementer: 'code', reviewer: 'review', tester: 'test' }
  })
  expect(await loadConfig(directory)).toEqual({
    base: 'develop',
    gate: 'bun test',
    push: true,
    harness: 'pi',
    harnessPaths: { claude: '/bin/claude', codex: '/bin/codex', pi: '/bin/pi' },
    watchdogMinutes: 0.5,
    models: { planner: 'plan', implementer: 'code', reviewer: 'review', tester: 'test' }
  })
})

test('partial nested config keeps unspecified defaults', async () => {
  writeConfig({ harnessPaths: { pi: '/opt/pi' }, models: { implementer: 'custom' } })
  const config = await loadConfig(directory)
  expect(config.harnessPaths).toEqual({ claude: 'claude', codex: 'codex', pi: '/opt/pi' })
  expect(config.models).toEqual({
    planner: 'opus',
    implementer: 'custom',
    reviewer: 'opus',
    tester: 'opus'
  })
})

test.each([
  ['run', 'epic'],
  ['child', 'bead'],
  ['status', 'epic']
])('%s reports its stub without claiming success', (command, target) => {
  expect(run([command, target])).toEqual({
    exitCode: 1,
    stdout: '',
    stderr: `simmer ${command} is not implemented yet\n`
  })
})

test.each([
  { config: { base: '' }, message: 'base must be a non-empty string' },
  { config: { base: null }, message: 'base must be a non-empty string' },
  { config: { gate: ' ' }, message: 'gate must be a non-empty string' },
  { config: { push: 'true' }, message: 'push must be a boolean' },
  { config: { harness: 'other' }, message: 'harness must be claude, codex, or pi' },
  { config: { harnessPaths: [] }, message: 'harnessPaths must be an object' },
  {
    config: { harnessPaths: { claude: 1 } },
    message: 'harnessPaths.claude must be a non-empty string'
  },
  {
    config: { harnessPaths: { codex: '' } },
    message: 'harnessPaths.codex must be a non-empty string'
  },
  {
    config: { harnessPaths: { pi: false } },
    message: 'harnessPaths.pi must be a non-empty string'
  },
  { config: { watchdogMinutes: 0 }, message: 'watchdogMinutes must be a positive finite number' },
  { config: { watchdogMinutes: -1 }, message: 'watchdogMinutes must be a positive finite number' },
  {
    config: { watchdogMinutes: '20' },
    message: 'watchdogMinutes must be a positive finite number'
  },
  { config: { models: null }, message: 'models must be an object' },
  { config: { models: { planner: 1 } }, message: 'models.planner must be a non-empty string' },
  {
    config: { models: { implementer: '' } },
    message: 'models.implementer must be a non-empty string'
  },
  {
    config: { models: { reviewer: false } },
    message: 'models.reviewer must be a non-empty string'
  },
  { config: { models: { tester: null } }, message: 'models.tester must be a non-empty string' },
  { config: { watchdogMinute: 20 }, message: 'watchdogMinute is unknown' },
  { config: { harnessPaths: { typo: 'pi' } }, message: 'harnessPaths.typo is unknown' },
  { config: { models: { typo: 'opus' } }, message: 'models.typo is unknown' },
  { config: [], message: 'simmer.json must be an object' },
  { config: null, message: 'simmer.json must be an object' }
])('invalid config reports $message through the CLI', ({ config, message }) => {
  writeConfig(config)
  expect(run(['run', 'epic'])).toEqual({
    exitCode: 1,
    stdout: '',
    stderr: `Invalid simmer.json: ${message}\n`
  })
})

test('malformed JSON reports the config file', () => {
  writeFileSync(join(directory, 'simmer.json'), '{')
  expect(run(['run', 'epic'])).toEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'Invalid simmer.json: simmer.json must contain valid JSON\n'
  })
})

test('infinite watchdog time is rejected', () => {
  writeFileSync(join(directory, 'simmer.json'), '{"watchdogMinutes":1e400}')
  expect(run(['child', 'bead'])).toEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'Invalid simmer.json: watchdogMinutes must be a positive finite number\n'
  })
})

test('config read errors remain errors', async () => {
  mkdirSync(join(directory, 'simmer.json'))
  await expect(loadConfig(directory)).rejects.toThrow('EISDIR')
})

test.each([
  { arguments: ['unknown'], message: 'Unknown command: unknown' },
  { arguments: ['run'], message: 'Usage: simmer run <epic>' },
  { arguments: ['child'], message: 'Usage: simmer child <bead>' },
  { arguments: ['status', 'epic', 'extra'], message: 'Usage: simmer status <epic>' },
  {
    arguments: ['child', 'bead', '--harness', 'other'],
    message: '--harness must be claude, codex, or pi'
  }
])('bad arguments report $message', ({ arguments: commandArguments, message }) => {
  expect(run(commandArguments)).toEqual({ exitCode: 1, stdout: '', stderr: `${message}\n` })
})

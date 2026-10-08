import { afterEach, beforeEach, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { harnessChoices, harnessNames, harnessRegistry } from '../src/harness/registry'

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
  --harness ${harnessNames.join('|')}   Select the worker harness
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
  cpSync(join(projectRoot, 'src'), join(directory, 'src'), { recursive: true })
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
  expect(await loadConfig(directory)).toMatchObject({
    base: 'main',
    gate: 'bun run typecheck && bun run test',
    push: false,
    harness: 'claude',
    harnessPaths: { claude: 'claude', codex: 'codex', pi: 'pi' },
    watchdogMinutes: 20,
    models: {
      claude: { planner: 'opus', implementer: 'sonnet', reviewer: 'opus', tester: 'opus' },
      codex: { reviewer: 'claude:opus' },
      pi: { reviewer: 'claude:opus' }
    }
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
    models: {
      claude: { planner: 'plan', implementer: 'code', reviewer: 'review', tester: 'test' },
      codex: {
        planner: 'gpt-plan',
        implementer: 'gpt-code',
        reviewer: 'gpt-review',
        tester: 'gpt-test'
      },
      pi: { planner: 'pi-plan', implementer: 'pi-code', reviewer: 'pi-review', tester: 'pi-test' }
    }
  })
  expect(await loadConfig(directory)).toMatchObject({
    base: 'develop',
    gate: 'bun test',
    push: true,
    harness: 'pi',
    harnessPaths: { claude: '/bin/claude', codex: '/bin/codex', pi: '/bin/pi' },
    watchdogMinutes: 0.5,
    models: {
      claude: { planner: 'plan', implementer: 'code', reviewer: 'review', tester: 'test' },
      codex: {
        planner: 'gpt-plan',
        implementer: 'gpt-code',
        reviewer: 'gpt-review',
        tester: 'gpt-test'
      },
      pi: { planner: 'pi-plan', implementer: 'pi-code', reviewer: 'pi-review', tester: 'pi-test' }
    }
  })
})

test('partial nested config keeps only each harness defaults', async () => {
  writeConfig({
    harnessPaths: { pi: '/opt/pi' },
    models: {
      claude: { implementer: 'custom' },
      codex: { reviewer: 'gpt-review' },
      pi: { planner: 'pi-plan' }
    }
  })
  const config = await loadConfig(directory)
  expect(config.harnessPaths).toMatchObject({ claude: 'claude', codex: 'codex', pi: '/opt/pi' })
  expect(config.models).toMatchObject({
    claude: { planner: 'opus', implementer: 'custom', reviewer: 'opus', tester: 'opus' },
    codex: { reviewer: 'gpt-review' },
    pi: { planner: 'pi-plan', reviewer: 'claude:opus' }
  })
})

test('empty harness maps preserve their own defaults', async () => {
  writeConfig({ models: { claude: {}, codex: {}, pi: {} } })
  expect((await loadConfig(directory)).models).toMatchObject({
    claude: { planner: 'opus', implementer: 'sonnet', reviewer: 'opus', tester: 'opus' },
    codex: { reviewer: 'claude:opus' },
    pi: { reviewer: 'claude:opus' }
  })
})

test('changing the selected harness does not copy another harness models', async () => {
  writeConfig({ harness: 'claude', models: { claude: { reviewer: 'custom' } } })
  const config = await loadConfig(directory)
  config.harness = 'codex'
  expect(config.models[config.harness]).toEqual({ reviewer: 'claude:opus' })
  config.harness = 'pi'
  expect(config.models[config.harness]).toEqual({ reviewer: 'claude:opus' })
  expect(config.models.claude.reviewer).toBe('custom')
})

test.each([
  { config: { base: '' }, message: 'base must be a non-empty string' },
  { config: { base: null }, message: 'base must be a non-empty string' },
  { config: { gate: ' ' }, message: 'gate must be a non-empty string' },
  { config: { push: 'true' }, message: 'push must be a boolean' },
  { config: { harness: 'other' }, message: `harness must be ${harnessChoices}` },
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
  { config: { models: [] }, message: 'models must be an object' },
  { config: { models: { planner: 'opus' } }, message: 'models.planner is unknown' },
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

test.each(harnessNames)('%s validates its role map', async (harness) => {
  for (const value of [null, [], 'opus', 1, false]) {
    writeConfig({ models: { [harness]: value } })
    await expect(loadConfig(directory)).rejects.toThrow(`models.${harness} must be an object`)
  }
  writeConfig({ models: { [harness]: { typo: 'model' } } })
  await expect(loadConfig(directory)).rejects.toThrow(`models.${harness}.typo is unknown`)
  for (const role of ['planner', 'implementer', 'reviewer', 'tester']) {
    for (const value of [null, [], {}, 1, false, '', ' ']) {
      writeConfig({ models: { [harness]: { [role]: value } } })
      await expect(loadConfig(directory)).rejects.toThrow(
        `models.${harness}.${role} must be a non-empty string`
      )
    }
  }
})

test.each(['codex', 'pi'])('%s accepts Claude processes for every role', async (harness) => {
  for (const role of ['planner', 'implementer', 'reviewer', 'tester']) {
    writeConfig({ models: { [harness]: { [role]: ' claude:sonnet ' } } })
    expect((await loadConfig(directory)).models).toMatchObject({
      [harness]: { [role]: 'claude:sonnet' }
    })
    for (const model of ['claude:', 'claude:   ', ' claude: \t']) {
      writeConfig({ models: { [harness]: { [role]: model } } })
      await expect(loadConfig(directory)).rejects.toThrow(
        `models.${harness}.${role} must name a model after claude:`
      )
    }
    for (const model of ['claude:op\nus', 'claude:op\tus', 'claude:op\0us']) {
      writeConfig({ models: { [harness]: { [role]: model } } })
      await expect(loadConfig(directory)).rejects.toThrow(
        `models.${harness}.${role} must not contain control characters in the Claude model`
      )
    }
    writeConfig({ models: { [harness]: { [role]: 'claude:--help' } } })
    await expect(loadConfig(directory)).rejects.toThrow(
      `models.${harness}.${role} must not start the Claude model with -`
    )
  }
})

test('Claude rejects Claude process prefixes for every role', async () => {
  for (const role of ['planner', 'implementer', 'reviewer', 'tester']) {
    for (const model of ['claude:opus', ' claude:opus ']) {
      writeConfig({ models: { claude: { [role]: model } } })
      await expect(loadConfig(directory)).rejects.toThrow(
        `models.claude.${role} cannot use claude:<model>; use a plain Claude model name`
      )
    }
  }
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
    message: `--harness must be ${harnessChoices}`
  }
])('bad arguments report $message', ({ arguments: commandArguments, message }) => {
  expect(run(commandArguments)).toEqual({ exitCode: 1, stdout: '', stderr: `${message}\n` })
})

test.each(harnessNames)(
  '%s loads registry defaults and accepts config overrides',
  async (harness) => {
    const defaults = await loadConfig(directory)
    expect(Object.keys(defaults.models)).toEqual(harnessNames)
    expect(Object.keys(defaults.harnessPaths)).toEqual(harnessNames)
    expect(defaults.harnessPaths[harness]).toBe(harnessRegistry[harness].defaultBinary)
    expect(defaults.models[harness]).toEqual(harnessRegistry[harness].defaultModels)
    writeConfig({
      harness,
      harnessPaths: { [harness]: '/custom/binary' },
      models: { [harness]: { reviewer: 'custom-review' } }
    })
    const config = await loadConfig(directory)
    expect(config.harness).toBe(harness)
    expect(config.harnessPaths[harness]).toBe('/custom/binary')
    expect(config.models[harness].reviewer).toBe('custom-review')
    expect(defaults.models[harness]).toEqual(harnessRegistry[harness].defaultModels)
  }
)

test.each(['other', 'toString', '__proto__', null, 12])(
  'config rejects unregistered harness %s',
  async (harness) => {
    writeConfig({ harness })
    await expect(loadConfig(directory)).rejects.toThrow(`harness must be ${harnessChoices}`)
  }
)

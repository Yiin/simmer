import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Harness = 'claude' | 'codex' | 'pi'
export type ModelRole = 'planner' | 'implementer' | 'reviewer' | 'tester'

export type Config = {
  base: string
  gate: string
  push: boolean
  harness: Harness
  harnessPaths: Record<Harness, string>
  watchdogMinutes: number
  models: Record<ModelRole, string>
}

function invalid(field: string, requirement: string): never {
  throw new Error(`Invalid simmer.json: ${field} ${requirement}`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) {
    invalid(field, 'must be an object')
  }
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(field, 'must be a non-empty string')
  }
  return value
}

function knownFields(value: Record<string, unknown>, fields: string[], prefix = ''): void {
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) invalid(`${prefix}${field}`, 'is unknown')
  }
}

export async function loadConfig(projectRoot = process.cwd()): Promise<Config> {
  let contents: string
  try {
    contents = await readFile(join(projectRoot, 'simmer.json'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      contents = '{}'
    } else {
      throw error
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    invalid('simmer.json', 'must contain valid JSON')
  }

  const config = object(parsed, 'simmer.json')
  knownFields(config, [
    'base',
    'gate',
    'push',
    'harness',
    'harnessPaths',
    'watchdogMinutes',
    'models'
  ])
  const harness = config.harness === undefined ? 'claude' : config.harness
  if (harness !== 'claude' && harness !== 'codex' && harness !== 'pi') {
    invalid('harness', 'must be claude, codex, or pi')
  }
  const push = config.push === undefined ? false : config.push
  if (typeof push !== 'boolean') invalid('push', 'must be a boolean')
  const watchdogMinutes = config.watchdogMinutes === undefined ? 20 : config.watchdogMinutes
  if (
    typeof watchdogMinutes !== 'number' ||
    !Number.isFinite(watchdogMinutes) ||
    watchdogMinutes <= 0
  ) {
    invalid('watchdogMinutes', 'must be a positive finite number')
  }

  const harnessPaths =
    config.harnessPaths === undefined ? {} : object(config.harnessPaths, 'harnessPaths')
  knownFields(harnessPaths, ['claude', 'codex', 'pi'], 'harnessPaths.')
  const models = config.models === undefined ? {} : object(config.models, 'models')
  knownFields(models, ['planner', 'implementer', 'reviewer', 'tester'], 'models.')

  return {
    base: text(config.base === undefined ? 'main' : config.base, 'base'),
    gate: text(
      config.gate === undefined ? 'bun run typecheck && bun run test' : config.gate,
      'gate'
    ),
    push,
    harness,
    harnessPaths: {
      claude: text(
        harnessPaths.claude === undefined ? 'claude' : harnessPaths.claude,
        'harnessPaths.claude'
      ),
      codex: text(
        harnessPaths.codex === undefined ? 'codex' : harnessPaths.codex,
        'harnessPaths.codex'
      ),
      pi: text(harnessPaths.pi === undefined ? 'pi' : harnessPaths.pi, 'harnessPaths.pi')
    },
    watchdogMinutes,
    models: {
      planner: text(models.planner === undefined ? 'opus' : models.planner, 'models.planner'),
      implementer: text(
        models.implementer === undefined ? 'sonnet' : models.implementer,
        'models.implementer'
      ),
      reviewer: text(models.reviewer === undefined ? 'opus' : models.reviewer, 'models.reviewer'),
      tester: text(models.tester === undefined ? 'opus' : models.tester, 'models.tester')
    }
  }
}

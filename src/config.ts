import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Harness = 'claude' | 'codex' | 'pi'
export type ModelRole = 'planner' | 'implementer' | 'reviewer' | 'tester'
export type RoleModels = Partial<Record<ModelRole, string>>

export type Config = {
  base: string
  gate: string
  push: boolean
  harness: Harness
  harnessPaths: Record<Harness, string>
  watchdogMinutes: number
  models: Record<Harness, RoleModels>
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

function roleModels(value: unknown, harness: Harness, defaults: RoleModels): RoleModels {
  const fields = value === undefined ? {} : object(value, `models.${harness}`)
  const roles: ModelRole[] = ['planner', 'implementer', 'reviewer', 'tester']
  knownFields(fields, roles, `models.${harness}.`)
  const models = { ...defaults }
  for (const role of roles) {
    if (fields[role] !== undefined) {
      const field = `models.${harness}.${role}`
      const model = text(fields[role], field)
      const trimmed = model.trim()
      if (trimmed.startsWith('claude:')) {
        if (harness === 'claude') {
          invalid(field, 'cannot use claude:<model>; use a plain Claude model name')
        }
        const claudeModel = trimmed.slice('claude:'.length).trim()
        if (claudeModel === '') invalid(field, 'must name a model after claude:')
        if (
          [...claudeModel].some((character) => character.charCodeAt(0) < 32 || character === '\x7f')
        ) {
          invalid(field, 'must not contain control characters in the Claude model')
        }
        if (claudeModel.startsWith('-')) invalid(field, 'must not start the Claude model with -')
        models[role] = `claude:${claudeModel}`
      } else {
        models[role] = model
      }
    }
  }
  return models
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
  knownFields(models, ['claude', 'codex', 'pi'], 'models.')

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
      claude: roleModels(models.claude, 'claude', {
        planner: 'opus',
        implementer: 'sonnet',
        reviewer: 'opus',
        tester: 'opus'
      }),
      codex: roleModels(models.codex, 'codex', { reviewer: 'claude:opus' }),
      pi: roleModels(models.pi, 'pi', { reviewer: 'claude:opus' })
    }
  }
}

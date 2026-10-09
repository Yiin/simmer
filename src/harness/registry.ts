import type { RoleModels } from '../config'
import { run as claude } from './claude'
import { run as codex } from './codex'
import { run as crush } from './crush'
import { run as gemini } from './gemini'
import { run as kimi } from './kimi'
import { run as opencode } from './opencode'
import { run as pi } from './pi'
import type { HarnessResult, RunOptions } from './process'

type HarnessDefinition = {
  defaultBinary: string
  run: (options: RunOptions) => Promise<HarnessResult>
  defaultModels: RoleModels
  // Whether the adapter passes RunOptions.effort to its CLI.
  supportsEffort: boolean
}

export const harnessRegistry = {
  claude: {
    defaultBinary: 'claude',
    run: claude,
    defaultModels: { planner: 'opus', implementer: 'sonnet', reviewer: 'opus', tester: 'opus' },
    supportsEffort: true
  },
  codex: {
    defaultBinary: 'codex',
    run: codex,
    defaultModels: { reviewer: 'claude:opus' },
    supportsEffort: true
  },
  pi: {
    defaultBinary: 'pi',
    run: pi,
    defaultModels: { reviewer: 'claude:opus' },
    supportsEffort: true
  },
  gemini: {
    defaultBinary: 'gemini',
    run: gemini,
    defaultModels: { reviewer: 'claude:opus' },
    supportsEffort: false
  },
  kimi: {
    defaultBinary: 'kimi',
    run: kimi,
    defaultModels: { reviewer: 'claude:opus' },
    supportsEffort: false
  },
  opencode: {
    defaultBinary: 'opencode',
    run: opencode,
    defaultModels: { reviewer: 'claude:opus' },
    supportsEffort: true
  },
  crush: {
    defaultBinary: 'crush',
    run: crush,
    defaultModels: { reviewer: 'claude:opus' },
    supportsEffort: true
  }
} satisfies Record<string, HarnessDefinition>

export type Harness = keyof typeof harnessRegistry

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && Object.hasOwn(harnessRegistry, value)
}

export const harnessNames = Object.keys(harnessRegistry).filter(isHarness)
export const harnessChoices = new Intl.ListFormat('en', { type: 'disjunction' }).format(
  harnessNames
)

export function mapHarnesses<T>(value: (definition: HarnessDefinition, name: Harness) => T) {
  // Every registry key gets a value; Object.fromEntries loses that key information.
  return Object.fromEntries(
    harnessNames.map((name) => [name, value(harnessRegistry[name], name)])
  ) as Record<Harness, T>
}

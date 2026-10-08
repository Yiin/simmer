import type { Config } from '../config'
import type { RunOptions } from './process'
import { harnessRegistry } from './registry'

export type { HarnessResult, Usage } from './process'

export function runHarness(
  options: Pick<RunOptions, 'prompt' | 'cwd' | 'watchdogIntervalMs' | 'env' | 'signal'> & {
    config: Pick<Config, 'harness' | 'harnessPaths' | 'models' | 'watchdogMinutes'>
  }
) {
  const { config } = options
  return harnessRegistry[config.harness].run({
    prompt: options.prompt,
    cwd: options.cwd,
    models: config.models[config.harness],
    binary: config.harnessPaths[config.harness],
    watchdogMinutes: config.watchdogMinutes,
    env: options.env,
    signal: options.signal,
    watchdogIntervalMs: options.watchdogIntervalMs
  })
}

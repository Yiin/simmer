import type { Config } from '../config'
import { run as claude } from './claude'
import { run as codex } from './codex'
import { run as pi } from './pi'
import type { RunOptions } from './process'

export type { HarnessResult, Usage } from './process'

export function runHarness(
  options: Pick<RunOptions, 'prompt' | 'cwd' | 'watchdogIntervalMs' | 'env' | 'signal'> & {
    config: Pick<Config, 'harness' | 'harnessPaths' | 'models' | 'watchdogMinutes'>
  }
) {
  const { config } = options
  return { claude, codex, pi }[config.harness]({
    prompt: options.prompt,
    cwd: options.cwd,
    models: config.models,
    binary: config.harnessPaths[config.harness],
    watchdogMinutes: config.watchdogMinutes,
    env: options.env,
    signal: options.signal,
    watchdogIntervalMs: options.watchdogIntervalMs
  })
}

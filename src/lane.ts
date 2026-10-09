import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from './config'
import type { Usage } from './harness'
import { type Harness, harnessChoices, harnessRegistry, isHarness } from './harness/registry'

export type LaneOptions = {
  brief: string
  worktree: string
  harness?: Harness
  model?: string
  effort?: string
  out?: string
  watchdogMinutes: number
  timeoutMinutes: number
  json: boolean
}

export const laneHelp = `Usage: simmer lane <brief-file> --worktree <dir> [options]

Runs one brief on one harness, headless, in an existing directory.
It does not claim beads, run a gate, land commits, or create worktrees.

Options:
  --worktree <dir>            Directory to run in (required, must exist)
  --harness <name>            ${harnessChoices}
                              (default: simmer.json harness in the worktree, else claude)
  --model <model>             Model for the whole run
  --effort <level>            Reasoning effort, where the harness supports it
  --out <file>                Also write the final message to this file
  --watchdog-minutes <n>      Kill the harness after n silent minutes (default 45)
  --timeout-minutes <n>       Kill the harness after n minutes in total (default 720)
  --json                      Print JSON events instead of the final message
  -h, --help                  Show help

Exit codes: 0 success, 124 timeout, 125 watchdog kill, else the harness exit code.
`

function positiveMinutes(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback
  const minutes = Number(value)
  if (value.trim() === '' || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`${flag} must be a positive number`)
  }
  return minutes
}

function cliValue(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined
  const control = [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (value.trim() === '' || value.startsWith('-') || control) {
    throw new Error(`${flag} must be a non-empty value without control characters or a leading -`)
  }
  return value
}

// Returns undefined when the caller asked for help.
export function parseLaneArgs(args: string[]): LaneOptions | undefined {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      worktree: { type: 'string' },
      harness: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      out: { type: 'string' },
      'watchdog-minutes': { type: 'string' },
      'timeout-minutes': { type: 'string' },
      json: { type: 'boolean' }
    }
  })
  if (values.help) return undefined
  const [brief] = positionals
  if (!brief || positionals.length !== 1) {
    throw new Error('Usage: simmer lane <brief-file> --worktree <dir>')
  }
  if (!values.worktree) throw new Error('simmer lane needs --worktree <dir>')
  if (values.harness !== undefined && !isHarness(values.harness)) {
    throw new Error(`--harness must be ${harnessChoices}`)
  }
  return {
    brief,
    worktree: values.worktree,
    harness: values.harness,
    model: cliValue(values.model, '--model'),
    effort: cliValue(values.effort, '--effort'),
    out: values.out,
    watchdogMinutes: positiveMinutes(values['watchdog-minutes'], '--watchdog-minutes', 45),
    timeoutMinutes: positiveMinutes(values['timeout-minutes'], '--timeout-minutes', 720),
    json: values.json ?? false
  }
}

function formatUsage(usage: Usage): string {
  return `usage: input ${usage.inputTokens}, output ${usage.outputTokens}, cache read ${usage.cacheReadTokens}, cache write ${usage.cacheWriteTokens}`
}

// Runs one brief and returns the process exit code. Throws on bad input or an interrupt.
export async function runLane(options: LaneOptions, signal?: AbortSignal): Promise<number> {
  const worktree = resolve(options.worktree)
  const info = await stat(worktree).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`--worktree ${worktree} is not an existing directory`)
  const brief = await readFile(options.brief, 'utf8').catch((error: unknown) => {
    throw new Error(
      `Cannot read brief ${options.brief}: ${error instanceof Error ? error.message : error}`
    )
  })
  if (brief.trim() === '') throw new Error(`Brief ${options.brief} is empty`)

  const config = await loadConfig(worktree)
  const harness = options.harness ?? config.harness
  const definition = harnessRegistry[harness]
  let effort = options.effort
  if (effort !== undefined && !definition.supportsEffort) {
    process.stderr.write(
      `simmer lane: ${harness} has no reasoning effort flag; ignoring --effort\n`
    )
    effort = undefined
  }
  function event(type: string, details: Record<string, unknown>) {
    if (options.json) process.stdout.write(`${JSON.stringify({ event: type, ...details })}\n`)
  }
  event('lane-started', { harness, model: options.model ?? null, effort: effort ?? null, worktree })

  const start = Date.now()
  const timeout = AbortSignal.timeout(options.timeoutMinutes * 60000)
  const result = await definition.run({
    // CLIs read a prompt that starts with - as an option, so a brief with frontmatter would fail.
    prompt: brief.startsWith('-') ? `\n${brief}` : brief,
    cwd: worktree,
    model: options.model,
    effort,
    binary: config.harnessPaths[harness],
    watchdogMinutes: options.watchdogMinutes,
    signal: AbortSignal.any([timeout, ...(signal ? [signal] : [])])
  })
  signal?.throwIfAborted()

  const [exitCode, reason] = timeout.aborted
    ? [124, `timed out after ${options.timeoutMinutes} minutes`]
    : result.killedByWatchdog
      ? [125, `watchdog killed ${harness} after ${options.watchdogMinutes} silent minutes`]
      : result.exitCode !== 0
        ? [result.exitCode, `${harness} exited ${result.exitCode}`]
        : [0, undefined]

  if (options.out !== undefined) await writeFile(options.out, result.finalMessage)
  if (options.json) {
    event('done', {
      outcome: reason ?? 'passed',
      exitCode,
      harness,
      durationMs: Date.now() - start,
      usage: result.usage ?? null,
      finalMessage: result.finalMessage
    })
  } else if (result.finalMessage !== '') {
    process.stdout.write(`${result.finalMessage}\n`)
  }
  if (result.usage) process.stderr.write(`simmer lane: ${formatUsage(result.usage)}\n`)
  if (reason) process.stderr.write(`simmer lane: ${reason}\n`)
  return exitCode
}

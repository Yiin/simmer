import { renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from './config'
import type { HarnessResult, Usage } from './harness'
import { sumUsage, type TurnProgress } from './harness/process'
import { type Harness, harnessChoices, harnessRegistry, isHarness } from './harness/registry'

export type LaneOptions = {
  brief: string
  worktree: string
  harness?: Harness
  model?: string
  effort?: string
  out?: string
  usageOut?: string
  contextCeiling?: number
  maxRelays: number
  watchdogMinutes: number
  timeoutMinutes: number
  json: boolean
}

export const RELAY_MARKER = 'RELAY-HANDOFF'
export const RELAY_GRACE_TURNS = 20
const HANDOFF_LIMIT = 8000

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
  --usage-out <file>          Write usage as JSON to this file, after every turn and at the end
  --context-ceiling <tokens>  Relay to a fresh agent when a turn's context passes this size
                              (claude and agy; other harnesses ignore it with a warning)
  --max-relays <n>            Relays per run at most (default 3); the last agent runs past
                              the ceiling
  --watchdog-minutes <n>      Kill the harness after n silent minutes (default 45)
  --timeout-minutes <n>       Kill the harness after n minutes in total (default 720)
  --json                      Print JSON events instead of the final message
  -h, --help                  Show help

Exit codes: 0 success, 124 timeout, 125 watchdog kill, else the harness exit code.

Relay: with --context-ceiling, the brief gets a relay rule. When a turn's context passes the
ceiling, simmer asks the agent, at its next tool boundary, to commit finished work, write a
handoff and end with the line ${RELAY_MARKER}. A fresh agent then gets the brief plus that
handoff. An agent that keeps working ${RELAY_GRACE_TURNS} turns after the request is stopped
after a tool call returns, and the fresh agent starts from git and the lane log.
`

function positiveMinutes(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback
  const minutes = Number(value)
  if (value.trim() === '' || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`${flag} must be a positive number`)
  }
  return minutes
}

function count(value: string | undefined, flag: string, minimum: number): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${flag} must be a whole number of at least ${minimum}`)
  }
  return number
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
      'usage-out': { type: 'string' },
      'context-ceiling': { type: 'string' },
      'max-relays': { type: 'string' },
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
    usageOut: values['usage-out'],
    contextCeiling: count(values['context-ceiling'], '--context-ceiling', 1),
    maxRelays: count(values['max-relays'], '--max-relays', 0) ?? 3,
    watchdogMinutes: positiveMinutes(values['watchdog-minutes'], '--watchdog-minutes', 45),
    timeoutMinutes: positiveMinutes(values['timeout-minutes'], '--timeout-minutes', 720),
    json: values.json ?? false
  }
}

// One agent run inside a lane. A lane has more than one when it relays at the context ceiling.
export type LaneRun = {
  exitCode: number
  // done: the agent finished. relay: it wrote a handoff at the ceiling. stopped: simmer stopped it
  // after it ignored the relay request. failed: nonzero exit, timeout or watchdog.
  ended: 'done' | 'relay' | 'stopped' | 'failed'
  turns: number | null
  peakContext: number | null
  usage: Usage | null
}

export type LaneUsage = Usage & {
  running: boolean
  harness: string
  model: string | null
  turns: number | null
  peakContext: number | null
  lastContext: number | null
  contextCeiling: number | null
  relays: number
  maxRelays: number
  runs: LaneRun[]
  // The compact string for the routing ledger's cost field.
  summary: string
  updatedAt: string
}

function compact(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value < 1e7 ? 1 : 0)}M`
  if (value >= 1e3) return `${Math.round(value / 1e3)}k`
  return String(value)
}

export function usageSummary(
  value: Usage & { turns: number | null; peakContext: number | null; relays: number }
): string {
  return [
    `out=${compact(value.outputTokens)}`,
    `cr=${compact(value.cacheReadTokens)}`,
    ...(value.turns === null ? [] : [`turns=${value.turns}`]),
    ...(value.peakContext === null ? [] : [`peak=${compact(value.peakContext)}`]),
    `relays=${value.relays}`
  ].join(' ')
}

function formatUsage(value: LaneUsage, ceiling: boolean): string {
  return [
    `usage: input ${value.inputTokens}, output ${value.outputTokens}, cache read ${value.cacheReadTokens}, cache write ${value.cacheWriteTokens}`,
    ...(value.turns === null ? [] : [`turns ${value.turns}`]),
    ...(value.peakContext === null ? [] : [`peak context ${value.peakContext}`]),
    ...(ceiling ? [`relays ${value.relays}`] : [])
  ].join(', ')
}

function relayRule(ceiling: number): string {
  return `

## Relay rule (from simmer, the tool that runs you)
This run has a context ceiling of ${ceiling} tokens. When your context passes it, simmer sends a hook message that starts with "SIMMER RELAY:". That message is part of this brief. When it arrives:
1. Finish the tool step you are in. Start no new work. Leave no file half-written.
2. Commit finished work in logical commits. Do not push or land half-done work.
3. Write a short handoff into your lane log, if this brief names one.
4. End your reply with the handoff: what is done (with commit SHAs), what is next, which files are uncommitted and why, and any trap the next agent must know. The last line of the reply must be exactly ${RELAY_MARKER}
A fresh agent then continues from this brief and your handoff.`
}

function relaySection(relay: number, maxRelays: number, handoff: string | undefined): string {
  const earlier =
    handoff === undefined
      ? `Its context passed the ceiling. It did not stop when asked, so simmer stopped it right after a tool call returned. It left no handoff.`
      : `Its context passed the ceiling, so it stopped and wrote this handoff:

<handoff>
${handoff}
</handoff>`
  return `

## Relay ${relay} of at most ${maxRelays}
You continue the work of an earlier agent on this brief. ${earlier}

Start with \`git status\` and \`git log --oneline -15\` in the worktree, and read the lane log this brief names. Do not redo finished work. Where the handoff and git disagree, trust git.`
}

// The prompt for one agent run: the brief, the relay rule while relays remain, and the handoff.
export function lanePrompt(
  brief: string,
  relay: { ceiling: number; index: number; maxRelays: number; handoff?: string } | undefined
): string {
  let prompt = brief
  if (relay && relay.index < relay.maxRelays) prompt += relayRule(relay.ceiling)
  if (relay && relay.index > 0) prompt += relaySection(relay.index, relay.maxRelays, relay.handoff)
  // CLIs read a prompt that starts with - as an option, so a brief with frontmatter would fail.
  return prompt.startsWith('-') ? `\n${prompt}` : prompt
}

// The reply without its last line, when that line is the relay marker.
export function relayHandoff(finalMessage: string): string | undefined {
  const lines = finalMessage.trimEnd().split('\n')
  const last = lines.at(-1)?.replace(/[`*_\s]/g, '')
  if (last !== RELAY_MARKER) return undefined
  const handoff = lines.slice(0, -1).join('\n').trim()
  return handoff.length > HANDOFF_LIMIT ? `...${handoff.slice(-HANDOFF_LIMIT)}` : handoff
}

function writeAtomic(file: string, text: string) {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
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
  let ceiling = options.contextCeiling
  if (ceiling !== undefined && !definition.supportsRelay) {
    process.stderr.write(
      `simmer lane: ${harness} cannot relay at a context ceiling; ignoring --context-ceiling\n`
    )
    ceiling = undefined
  }
  function event(type: string, details: Record<string, unknown>) {
    if (options.json) process.stdout.write(`${JSON.stringify({ event: type, ...details })}\n`)
  }
  event('lane-started', { harness, model: options.model ?? null, effort: effort ?? null, worktree })

  const runs: LaneRun[] = []
  let live: TurnProgress | undefined
  let lastWrite = 0
  function laneUsage(running: boolean): LaneUsage {
    const done = runs.flatMap((run) => (run.usage ? [run.usage] : []))
    const total = sumUsage(live ? [...done, live.usage] : done)
    const turnCounts = [...runs.map((run) => run.turns), ...(live ? [live.turns] : [])]
    const peaks = [...runs.map((run) => run.peakContext), ...(live ? [live.peakContext] : [])]
    const known = <T>(values: (T | null)[]) => values.filter((value): value is T => value !== null)
    const turns = known(turnCounts).length ? known(turnCounts).reduce((a, b) => a + b, 0) : null
    const peakContext = known(peaks).length ? Math.max(...known(peaks)) : null
    const relays = runs.filter((run) => run.ended === 'relay' || run.ended === 'stopped').length
    return {
      running,
      harness,
      model: options.model ?? null,
      ...total,
      turns,
      peakContext,
      lastContext: live?.context ?? null,
      contextCeiling: ceiling ?? null,
      relays,
      maxRelays: options.maxRelays,
      runs,
      summary: usageSummary({ ...total, turns, peakContext, relays }),
      updatedAt: new Date().toISOString()
    }
  }
  function writeUsage(running: boolean) {
    if (options.usageOut === undefined) return
    // Live updates at most every 2 s; the watchdog reads this file while the lane runs.
    if (running && Date.now() - lastWrite < 2000) return
    lastWrite = Date.now()
    writeAtomic(options.usageOut, `${JSON.stringify(laneUsage(running), null, 2)}\n`)
  }

  const start = Date.now()
  const timeout = AbortSignal.timeout(options.timeoutMinutes * 60000)
  const relayFolder =
    ceiling === undefined ? undefined : await mkdtemp(join(tmpdir(), 'simmer-relay-'))
  let result: HarnessResult
  let handoff: string | undefined
  try {
    for (let index = 0; ; index++) {
      const signalFile =
        relayFolder !== undefined && index < options.maxRelays
          ? join(relayFolder, `relay-${index}.json`)
          : undefined
      const stop = new AbortController()
      let askedAtTurn: number | undefined
      live = undefined
      result = await definition.run({
        prompt: lanePrompt(
          brief,
          ceiling === undefined
            ? undefined
            : { ceiling, index, maxRelays: options.maxRelays, handoff }
        ),
        cwd: worktree,
        model: options.model,
        effort,
        binary: config.harnessPaths[harness],
        watchdogMinutes: options.watchdogMinutes,
        signal: AbortSignal.any([timeout, stop.signal, ...(signal ? [signal] : [])]),
        relaySignalFile: signalFile,
        onTurn(progress) {
          live = progress
          if (
            signalFile !== undefined &&
            ceiling !== undefined &&
            askedAtTurn === undefined &&
            progress.context > ceiling
          ) {
            askedAtTurn = progress.turns
            const reason = `SIMMER RELAY: your context is ${progress.context} tokens, past the ceiling of ${ceiling}. Follow the relay rule in your brief now.`
            writeAtomic(signalFile, JSON.stringify({ decision: 'block', reason }))
            process.stderr.write(
              `simmer lane: context ${progress.context} passed the ceiling ${ceiling}; asked for a relay handoff\n`
            )
            event('relay-requested', { context: progress.context, turn: progress.turns })
          }
          writeUsage(true)
        },
        onToolResult() {
          if (
            askedAtTurn !== undefined &&
            live !== undefined &&
            live.turns - askedAtTurn >= RELAY_GRACE_TURNS &&
            !stop.signal.aborted
          ) {
            process.stderr.write(
              `simmer lane: no handoff ${RELAY_GRACE_TURNS} turns after the relay request; stopping the agent after a tool call\n`
            )
            stop.abort()
          }
        }
      })
      signal?.throwIfAborted()
      live = undefined
      const failed = timeout.aborted || result.killedByWatchdog
      const stopped = !failed && stop.signal.aborted
      const nextHandoff =
        !failed && !stopped && askedAtTurn !== undefined && result.exitCode === 0
          ? relayHandoff(result.finalMessage)
          : undefined
      const ended: LaneRun['ended'] = stopped
        ? 'stopped'
        : nextHandoff !== undefined
          ? 'relay'
          : failed || result.exitCode !== 0
            ? 'failed'
            : 'done'
      runs.push({
        exitCode: stopped ? 0 : result.exitCode,
        ended,
        turns: result.turns ?? null,
        peakContext: result.peakContext ?? null,
        usage: result.usage ?? null
      })
      writeUsage(true)
      if (ended !== 'relay' && ended !== 'stopped') break
      handoff = nextHandoff
      process.stderr.write(
        `simmer lane: relay ${index + 1} of at most ${options.maxRelays}: starting a fresh agent\n`
      )
      event('relay', { relay: index + 1, ended, turns: result.turns ?? null })
    }
  } finally {
    if (relayFolder !== undefined) await rm(relayFolder, { recursive: true, force: true })
  }

  const [exitCode, reason] = timeout.aborted
    ? [124, `timed out after ${options.timeoutMinutes} minutes`]
    : result.killedByWatchdog
      ? [125, `watchdog killed ${harness} after ${options.watchdogMinutes} silent minutes`]
      : result.exitCode !== 0
        ? [result.exitCode, `${harness} exited ${result.exitCode}`]
        : [0, undefined]

  const totals = laneUsage(false)
  let finalMessage = result.finalMessage
  if (totals.relays > 0) {
    const capped =
      totals.relays >= options.maxRelays
        ? ' That is the cap, so the last agent ran without a ceiling.'
        : ''
    finalMessage += `\n\n---\nsimmer lane: this run used ${totals.relays} relay(s) at a context ceiling of ${ceiling} tokens (at most ${options.maxRelays}).${capped}`
  }
  if (options.out !== undefined) await writeFile(options.out, finalMessage)
  writeUsage(false)
  const reported = runs.some((run) => run.usage !== null)
  if (options.json) {
    event('done', {
      outcome: reason ?? 'passed',
      exitCode,
      harness,
      durationMs: Date.now() - start,
      usage: reported
        ? {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens
          }
        : null,
      turns: totals.turns,
      peakContext: totals.peakContext,
      relays: totals.relays,
      finalMessage
    })
  } else if (finalMessage !== '') {
    process.stdout.write(`${finalMessage}\n`)
  }
  if (reported) {
    process.stderr.write(`simmer lane: ${formatUsage(totals, ceiling !== undefined)}\n`)
  }
  if (reason) process.stderr.write(`simmer lane: ${reason}\n`)
  return exitCode
}

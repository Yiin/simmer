#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { version } from '../package.json'
import { loadConfig } from './config'
import { harnessChoices, harnessNames, isHarness } from './harness/registry'

const help = `Usage: simmer <command> [options]

Commands:
  run <epic>                 Run ready children in order
  child <bead>               Run one child
  status <epic>              Show epic progress
  lane <brief-file>          Run one brief on one harness (see simmer lane --help)

Options:
  --harness ${harnessNames.join('|')}   Select the worker harness
  --json                     Print JSON events
  --worktree <path>           Use an existing worktree (child)
  --no-land                  Skip landing (child)
  -h, --help                 Show help
  -v, --version              Show the package version
`

async function withInterrupts(work: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController()
  function interrupt(signal: NodeJS.Signals) {
    const error = new Error(`Interrupted by ${signal}`)
    controller.abort(error)
    process.exitCode = signal === 'SIGINT' ? 130 : 143
  }
  const onInterrupt = () => interrupt('SIGINT')
  const onTerminate = () => interrupt('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  try {
    await work(controller.signal)
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
}

async function main(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      harness: { type: 'string' },
      json: { type: 'boolean' },
      worktree: { type: 'string' },
      'no-land': { type: 'boolean' }
    }
  })

  if (values.version) {
    process.stdout.write(`${version}\n`)
  } else if (values.help || positionals.length === 0) {
    process.stdout.write(help)
  } else {
    const [command, target] = positionals
    const harness = values.harness
    if (command !== 'run' && command !== 'child' && command !== 'status') {
      throw new Error(`Unknown command: ${command}`)
    }
    if (!target || positionals.length !== 2) {
      throw new Error(`Usage: simmer ${command} <${command === 'child' ? 'bead' : 'epic'}>`)
    }
    if (harness !== undefined && !isHarness(harness)) {
      throw new Error(`--harness must be ${harnessChoices}`)
    }
    if (command === 'status') {
      const { printStatus } = await import('./status')
      await printStatus({ epic: target, cwd: process.cwd(), json: values.json })
    } else {
      await withInterrupts(async (signal) => {
        const config = await loadConfig()
        if (harness !== undefined) config.harness = harness
        if (command === 'child') {
          const { runChild } = await import('./child')
          const result = await runChild({
            id: target,
            cwd: process.cwd(),
            config,
            worktree: values.worktree,
            noLand: values['no-land'],
            json: values.json,
            signal
          })
          process.exitCode = result.exitCode
        } else if (command === 'run') {
          const { runEpic } = await import('./run')
          process.exitCode = await runEpic({
            epic: target,
            cwd: process.cwd(),
            config,
            json: values.json,
            signal
          })
        }
      })
    }
  }
}

try {
  const args = process.argv.slice(2)
  if (args[0] === 'lane') {
    // lane has its own flags, so it parses its arguments itself.
    const { laneHelp, parseLaneArgs, runLane } = await import('./lane')
    const options = parseLaneArgs(args.slice(1))
    if (options === undefined) {
      process.stdout.write(laneHelp)
    } else {
      await withInterrupts(async (signal) => {
        process.exitCode = await runLane(options, signal)
      })
    }
  } else {
    await main(args)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = 1
}

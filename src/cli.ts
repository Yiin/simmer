#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { version } from '../package.json'
import { loadConfig } from './config'

const help = `Usage: simmer <command> [options]

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
`

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
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
    if (command !== 'run' && command !== 'child' && command !== 'status') {
      throw new Error(`Unknown command: ${command}`)
    }
    if (!target || positionals.length !== 2) {
      throw new Error(`Usage: simmer ${command} <${command === 'child' ? 'bead' : 'epic'}>`)
    }
    if (
      values.harness !== undefined &&
      values.harness !== 'claude' &&
      values.harness !== 'codex' &&
      values.harness !== 'pi'
    ) {
      throw new Error('--harness must be claude, codex, or pi')
    }
    const config = await loadConfig()
    if (values.harness !== undefined) config.harness = values.harness
    if (command === 'child') {
      const { runChild } = await import('./child')
      const result = await runChild({
        id: target,
        cwd: process.cwd(),
        config,
        worktree: values.worktree,
        noLand: values['no-land'],
        json: values.json
      })
      process.exitCode = result.exitCode
    } else {
      throw new Error(`simmer ${command} is not implemented yet`)
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { RoleModels } from '../config'

// inputTokens counts only uncached input. Cache fields are 0 when a stream does not report them.
export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
export type HarnessResult = {
  exitCode: number
  finalMessage: string
  usage: Usage | undefined
  killedByWatchdog: boolean
}
export type RunOptions = {
  prompt: string
  cwd: string
  models: RoleModels
  binary: string
  watchdogMinutes: number
  watchdogIntervalMs?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}
export type StreamEvent = {
  finalMessage?: string
  usage?: Usage
  usageKey?: string
}

const executeFile = promisify(execFile)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function usage(
  inputTokens: unknown,
  outputTokens: unknown,
  cacheReadTokens?: unknown,
  cacheWriteTokens?: unknown
): Usage | undefined {
  const input = tokenCount(inputTokens)
  const output = tokenCount(outputTokens)
  const cacheRead = tokenCount(cacheReadTokens ?? 0)
  const cacheWrite = tokenCount(cacheWriteTokens ?? 0)
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined
  }
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite
  }
}

export function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((block: unknown) => {
    const value = record(block)
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  })
  return text.length ? text.join('') : undefined
}

export function agents(models: RoleModels) {
  return {
    planner: {
      description: 'Plans the child task',
      prompt: 'Plan the child task using its spec and the project design.',
      model: models.planner
    },
    implementer: {
      description: 'Implements the child task',
      prompt: 'Implement the approved plan and follow the project rules.',
      model: models.implementer
    },
    reviewer: {
      description: 'Reviews the plan and code',
      prompt: 'Review the plan and code against the spec. Report errors and risks.',
      model: models.reviewer
    },
    tester: {
      description: 'Checks the child task',
      prompt: 'Check the acceptance criteria and run the project gate.',
      model: models.tester
    }
  }
}

export function rolePrompt(prompt: string, models: RoleModels): string {
  const roles = Object.entries(agents(models)).map(([role, agent]) => {
    const model = agent.model === undefined ? '' : ` (model: ${agent.model})`
    const description = `${role}${model}: ${agent.prompt}`
    if (!agent.model?.startsWith('claude:')) return description
    const claudeModel = agent.model.slice('claude:'.length)
    const argument = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(claudeModel)
      ? claudeModel
      : `'${claudeModel.replaceAll("'", "'\\''")}'`
    return `${description}
Run this role as a one-shot Claude Code process using claude from PATH.
Replace the brief placeholder with a self-contained brief. Cite file paths instead of pasting whole diffs.
Give this process a read-only brief. It must not edit repository files.
Return proposed changes for the main worker to apply.
Choose a quoted heredoc delimiter that does not appear as a line in the brief.
Execute the complete script in one tool call in the current directory:
\`\`\`sh
(
  brief=$(mktemp "\${TMPDIR:-/tmp}/simmer-${role}-XXXXXX") || exit 1
  trap 'rm -f "\${brief:?}"' EXIT
  cat > "$brief" <<'SIMMER_ROLE_BRIEF'
REPLACE_WITH_SELF_CONTAINED_BRIEF
SIMMER_ROLE_BRIEF
  claude -p --model ${argument} --permission-mode bypassPermissions "$(cat "$brief")" < /dev/null
)
\`\`\`
Report the model only when Claude process output verifies it. You may add --output-format json to inspect modelUsage metadata.
Model self-description is not verification. If process metadata does not identify the model, report the model as unknown.`
  })
  return `${prompt}\n\nCook-it stage roles:\n${roles.join('\n')}`
}

async function head(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await executeFile('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      timeout: 5000
    })
    return stdout.trim()
  } catch {
    return undefined
  }
}

async function killTree(processId: number, workerId: string): Promise<void> {
  const descendants = new Set([processId])
  const entries = await readdir('/proc').catch(() => [])
  const processes = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        const childId = Number(entry)
        try {
          const status = await readFile(`/proc/${entry}/stat`, 'utf8')
          const parentId = Number(status.slice(status.lastIndexOf(')') + 2).split(' ')[1])
          try {
            const environment = await readFile(`/proc/${entry}/environ`, 'utf8')
            if (environment.split('\0').includes(`SIMMER_HARNESS_ID=${workerId}`)) {
              descendants.add(childId)
            }
          } catch {}
          return { childId, parentId }
        } catch {}
      })
  )
  for (const parentId of descendants) {
    for (const child of processes) {
      if (child?.parentId === parentId) descendants.add(child.childId)
    }
  }
  for (const childId of [...descendants].reverse()) {
    for (const targetId of [-childId, childId]) {
      try {
        process.kill(targetId, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
  }
}

export async function runProcess(
  command: string[],
  options: RunOptions,
  parse: ((event: Record<string, unknown>) => StreamEvent) | 'text'
): Promise<HarnessResult> {
  let previousHead = await head(options.cwd)
  let lastActivity = performance.now()
  let checking = false
  let closed = false
  let finalMessage = ''
  let killedByWatchdog = false
  let pending = ''
  let eventNumber = 0
  const workerId = randomUUID()
  const tokenUsage = new Map<string, Usage>()
  const worker = spawn(command[0] ?? '', command.slice(1), {
    cwd: options.cwd,
    detached: true,
    env: { ...process.env, ...options.env, SIMMER_HARNESS_ID: workerId },
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const watchdogMilliseconds = options.watchdogMinutes * 60000
  function abort() {
    if (!closed && worker.pid) {
      void killTree(worker.pid, workerId).catch((error: unknown) => {
        worker.emit('error', error)
      })
    }
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()

  function consume(line: string) {
    if (parse === 'text') return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    const event = parse(record(value))
    if (event.finalMessage !== undefined) finalMessage = event.finalMessage
    if (event.usage) {
      if (event.usageKey === 'total') tokenUsage.clear()
      tokenUsage.set(event.usageKey ?? String(eventNumber++), event.usage)
    }
  }

  worker.stdout.setEncoding('utf8')
  worker.stdout.on('data', (chunk: string) => {
    lastActivity = performance.now()
    if (parse === 'text') {
      finalMessage += chunk
      return
    }
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      consume(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  })

  const timer = setInterval(async () => {
    if (checking || closed || killedByWatchdog) return
    checking = true
    try {
      const currentHead = await head(options.cwd)
      if (closed) return
      if (currentHead !== undefined && currentHead !== previousHead) {
        previousHead = currentHead
        lastActivity = performance.now()
      } else if (performance.now() - lastActivity >= watchdogMilliseconds && worker.pid) {
        try {
          await killTree(worker.pid, workerId)
          killedByWatchdog = true
          worker.stdout.destroy()
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
            worker.emit('error', error)
          }
        }
      }
    } finally {
      checking = false
    }
  }, options.watchdogIntervalMs ?? Math.min(1000, watchdogMilliseconds))

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      worker.once('error', reject)
      worker.once('close', (code, signal) => resolve(code ?? (signal === 'SIGKILL' ? 137 : 1)))
    })
    consume(pending)
    const totals = [...tokenUsage.values()]
    return {
      exitCode,
      finalMessage: parse === 'text' ? finalMessage.trim() : finalMessage,
      usage: totals.length
        ? totals.reduce(
            (total, value) => ({
              inputTokens: total.inputTokens + value.inputTokens,
              outputTokens: total.outputTokens + value.outputTokens,
              cacheReadTokens: total.cacheReadTokens + value.cacheReadTokens,
              cacheWriteTokens: total.cacheWriteTokens + value.cacheWriteTokens
            }),
            { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
          )
        : undefined,
      killedByWatchdog
    }
  } finally {
    closed = true
    options.signal?.removeEventListener('abort', abort)
    clearInterval(timer)
  }
}

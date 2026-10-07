import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Bd } from './bd'
import type { Config } from './config'
import { Git, type LandingResult } from './git'
import { runHarness } from './harness'

export type ChildResult =
  | { kind: 'lost'; exitCode: 3 }
  | { kind: 'blocked'; exitCode: 2; reason: string }
  | { kind: 'done'; exitCode: 0; landing: LandingResult | { kind: 'skipped' } }

export async function runChild(options: {
  id: string
  cwd: string
  config: Config
  worktree?: string
  noLand?: boolean
  json?: boolean
  heartbeatIntervalMs?: number
}): Promise<ChildResult> {
  const { id, cwd, config } = options
  const actor = `${process.env.BEADS_ACTOR ?? process.env.USER ?? 'simmer'}-${randomUUID()}`
  const environment = { ...process.env, BEADS_ACTOR: actor }
  const bd = new Bd({ cwd, actor })
  const git = new Git({ cwd, base: config.base })
  function event(type: string, details: Record<string, unknown> = {}) {
    const gateExit = typeof details.exitCode === 'number' ? `, exit ${details.exitCode}` : ''
    const summary =
      typeof details.reason === 'string'
        ? `: ${details.reason.split('\n')[0]}`
        : typeof details.attempt === 'number'
          ? ` (attempt ${details.attempt}${gateExit})`
          : ''
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ event: type, id, ...details })}\n`
        : `${id}: ${type}${summary}\n`
    )
  }
  const issue = await bd.show(id)
  const epic = issue.parent
  if (!epic) throw new Error(`Bead ${id} has no parent epic`)
  if ((await bd.claim(id)).kind === 'lost') {
    event('done', { outcome: 'claim-lost' })
    return { kind: 'lost', exitCode: 3 }
  }
  let branch = `simmer/${epic}-child-${randomUUID()}`
  const controller = new AbortController()
  let heartbeatError: Error | undefined
  let heartbeat = Promise.resolve()
  let heartbeatBusy = false
  let heartbeatPaused = false
  const timer = setInterval(() => {
    if (heartbeatBusy || heartbeatPaused || heartbeatError) return
    heartbeatBusy = true
    heartbeat = heartbeat
      .then(async () => {
        try {
          await bd.heartbeat(id)
        } catch (error) {
          process.stderr.write(`Heartbeat for ${id}: ${errorMessage(error)}\n`)
          try {
            const current = await bd.show(id)
            if (current.assignee !== actor) {
              heartbeatError = new Error(`Claim lost to ${current.assignee || 'no assignee'}`)
              controller.abort()
            }
          } catch (showError) {
            process.stderr.write(
              `Heartbeat ownership check for ${id}: ${errorMessage(showError)}\n`
            )
          }
        }
      })
      .finally(() => {
        heartbeatBusy = false
      })
  }, options.heartbeatIntervalMs ?? 60_000)
  try {
    event('claimed')
    const worktree = await git.createWorktree({
      epic,
      path: options.worktree,
      adopt: options.worktree !== undefined,
      branch
    })
    branch = worktree.branch
    let failure = ''
    async function block(reason: string): Promise<ChildResult> {
      await bd.note(id, JSON.stringify({ branch, outcome: 'blocked', reason }))
      await bd.block(id)
      event('blocked', { reason })
      event('done', { outcome: 'blocked' })
      return { kind: 'blocked', exitCode: 2, reason }
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const start = Date.now()
      const previousCommits = await git.newCommits(worktree)
      const skill =
        config.harness === 'claude'
          ? `Use the cook-it skill on bead ${id}. On Claude Code, run /cook-it ${id}.`
          : `Follow the cook-it skill (in your skills folder) for bead ${id}.`
      const prompt = [
        skill,
        'You are unattended. Work only in this directory. Commit your work here.',
        `Close the bead with bd close ${id} --reason ... when done.`,
        'Do not push. Do not merge into or touch any other branch. simmer lands your commits.',
        `Task: ${issue.title}\n${issue.description}`,
        `Acceptance criteria:\n${issue.acceptanceCriteria}`,
        ...(failure
          ? [
              "The first attempt's commits are already on this branch. Build on them.",
              `Previous failure:\n${failure}`
            ]
          : [])
      ].join('\n\n')
      event('attempt-started', { attempt, harness: config.harness, worktree: worktree.path })
      const before = await bd.show(id, true)
      if (heartbeatError) throw heartbeatError
      const worker = await runHarness({
        prompt,
        cwd: worktree.path,
        config,
        env: environment,
        signal: controller.signal
      })
      const after = await bd.show(id, true)
      if (heartbeatError) throw heartbeatError
      const researchEffect =
        before.labels.includes('research') &&
        ((after.notes !== before.notes && after.notes.trim() !== '') ||
          after.comments.some(
            (comment) => !before.comments.some((prior) => prior.id === comment.id)
          ))
      const commits = await git.newCommits(worktree)
      const commitCount = commits.filter((commit) => !previousCommits.includes(commit)).length
      const closed = after.status === 'closed'
      const dirty = await git.hasUncommittedChanges(worktree)
      const gate = dirty ? undefined : await runGate(config.gate, worktree.path, environment)
      event('gate', { attempt, ...(gate ?? { skipped: 'uncommitted changes' }) })
      failure = [
        ...(worker.killedByWatchdog ? ['watchdog kill'] : []),
        ...(commits.length === 0 && !researchEffect ? ['no commit'] : []),
        ...(!closed ? ['bead not closed'] : []),
        ...(dirty ? ['uncommitted changes'] : []),
        ...(gate && gate.exitCode !== 0 ? [`Gate exited ${gate.exitCode}:\n${gate.output}`] : [])
      ].join('\n')
      const report = {
        harness: config.harness,
        models: config.models,
        attempt,
        durationMs: Date.now() - start,
        usage: worker.usage ?? null,
        harnessExit: worker.exitCode,
        gateExit: gate?.exitCode ?? null,
        commitCount,
        outcome: failure || 'passed'
      }
      await bd.note(id, JSON.stringify(report))
      event('attempt-finished', report)
      heartbeatPaused = true
      await heartbeat
      if (heartbeatError) throw heartbeatError
      if (!failure) {
        let landing: LandingResult | { kind: 'skipped' } = { kind: 'skipped' }
        if (!options.noLand) {
          landing = await git.integrate(worktree)
          if (landing.kind === 'landed') {
            try {
              landing = await git.land(worktree, config.push)
            } catch (error) {
              landing = { kind: 'deferred', files: [], reason: errorMessage(error) }
            }
            if (landing.kind === 'conflict' || landing.kind === 'push-failed') {
              landing = {
                kind: 'deferred',
                files: [],
                reason: landing.message,
                ...(landing.cleanupError ? { cleanupError: landing.cleanupError } : {})
              }
            }
          }
          await bd.note(epic, JSON.stringify({ id, branch, ...landing }))
          event(landing.kind, landing)
          if (landing.kind === 'conflict') return await block(landing.message)
        }
        event('done', { outcome: landing.kind })
        return { kind: 'done', exitCode: 0, landing }
      }
      if (attempt === 1) {
        if (closed) await bd.reopen(id, failure)
        heartbeatPaused = false
      }
    }
    return await block(failure)
  } catch (error) {
    heartbeatPaused = true
    clearInterval(timer)
    await heartbeat
    const reason = errorMessage(heartbeatError ?? error)
    for (const target of [id, epic]) {
      try {
        await bd.note(target, JSON.stringify({ id, branch, outcome: 'error', reason }))
      } catch (noteError) {
        process.stderr.write(`Error note for ${target}: ${errorMessage(noteError)}\n`)
      }
    }
    try {
      const current = await bd.show(id)
      if (current.assignee === actor || current.assignee === '') {
        await bd.reopen(id, reason, false)
        if (current.assignee === actor) await bd.unclaim(id)
      }
    } catch (recoveryError) {
      process.stderr.write(`Recovery for ${id}: ${errorMessage(recoveryError)}\n`)
      try {
        await bd.block(id)
      } catch (blockError) {
        process.stderr.write(`Blocking ${id}: ${errorMessage(blockError)}\n`)
      }
    }
    throw heartbeatError ?? error
  } finally {
    clearInterval(timer)
    await heartbeat
  }
}

async function runGate(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{
  exitCode: number
  output: string
}> {
  const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  function append(chunk: string) {
    output = failureTail(output + chunk, 81)
  }
  child.stdout.setEncoding('utf8').on('data', append)
  child.stderr.setEncoding('utf8').on('data', append)
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
  return { exitCode, output: failureTail(output.trimEnd()) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureTail(output: string, lines = 80): string {
  const bytes = Buffer.from(output.split('\n').slice(-lines).join('\n'))
  let start = Math.max(0, bytes.length - 8000)
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  return bytes.toString('utf8', start)
}

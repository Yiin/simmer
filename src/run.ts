import { randomUUID } from 'node:crypto'
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bd, BdError } from './bd'
import { ClaimLostError, runChild, runGate } from './child'
import type { Config } from './config'
import { Git, type LandingResult } from './git'
import { epicStatus, landingNote } from './status'

export async function runEpic(options: {
  epic: string
  cwd: string
  config: Config
  json?: boolean
  signal?: AbortSignal
}): Promise<number> {
  const { epic, cwd, config } = options
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(epic)) throw new Error(`Invalid bd issue ID: ${epic}`)
  const bd = new Bd({ cwd, actor: `simmer-run-${process.pid}`, signal: options.signal })
  const git = new Git({ cwd, base: config.base })
  const lock = join(await git.temporaryDirectory(), `${epic}.lock`)
  acquireLock(lock, epic)
  const counts = { done: 0, blocked: 0, lost: 0, errors: 0, deferred: 0 }
  function event(type: string, details: Record<string, unknown> = {}) {
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ event: type, epic, ...details })}\n`
        : `${epic}: ${type}${typeof details.reason === 'string' ? `: ${details.reason}` : ''}\n`
    )
  }
  try {
    event('run-started')
    const attempted = new Set<string>()
    let consecutiveErrors = 0
    let fatal = ''
    async function executeChild(
      id: string,
      recovery: Pick<Parameters<typeof runChild>[0], 'worktree' | 'resume'> = {}
    ) {
      attempted.add(id)
      try {
        const result = await runChild({
          id,
          cwd,
          config,
          json: options.json,
          recordRecovery: true,
          signal: options.signal,
          ...recovery
        })
        counts[result.kind]++
        if (result.kind === 'done') consecutiveErrors = 0
      } catch (error) {
        options.signal?.throwIfAborted()
        const reason = errorMessage(error)
        if (
          error instanceof ClaimLostError ||
          (error instanceof BdError && error.exitCode === 13)
        ) {
          counts.lost++
          event('claim-lost', { id, reason })
          return
        }
        counts.errors++
        consecutiveErrors++
        await bd.note(
          epic,
          `${JSON.stringify({ id, outcome: 'error', reason })}\nsimmer: stopped ${id}`
        )
        event('child-error', { id, reason })
        if (consecutiveErrors === 3) {
          fatal = `Unexpected errors occurred for 3 consecutive children: ${reason}`
        }
      }
    }
    let deferred = (await epicStatus(bd, epic)).deferred
    async function retryLandings() {
      for (const child of [...deferred]) {
        if (fatal) break
        options.signal?.throwIfAborted()
        let result: LandingResult
        let verified = !child.start
        let integrated = false
        try {
          const tip = await git.branchTip(child.branch)
          if (!tip) {
            const reason = `Branch ${child.branch} is missing`
            result = await git.landRun(epic, config.push)
            if (result.kind === 'landed') {
              await bd.note(epic, `simmer: dropped ${child.id} ${reason}`)
              event('dropped', { id: child.id, reason })
              deferred = (await epicStatus(bd, epic)).deferred
              continue
            }
          } else if (child.verified && (await git.isIntegrated(epic, child.verified))) {
            integrated = true
            result = await git.landRun(epic, config.push)
          } else {
            if (child.verified && child.verified !== tip) {
              verified = false
              throw new Error(`Branch ${child.branch} changed after verification`)
            }
            if (child.start) {
              const worktree = await git.recoverWorktree(epic, child.branch, child.start)
              if (worktree.path === cwd) throw new Error('Interrupted child branch is missing')
              const dirty = await git.hasUncommittedChanges(worktree)
              const commits = await git.newCommits(worktree)
              const issue = await bd.show(child.id)
              const researchPassed =
                issue.labels.includes('research') &&
                issue.notes.split('\n').some((line) => {
                  try {
                    const report: unknown = JSON.parse(line)
                    return (
                      typeof report === 'object' &&
                      report !== null &&
                      Reflect.get(report, 'branch') === child.branch &&
                      Reflect.get(report, 'outcome') === 'passed' &&
                      Reflect.get(report, 'gateExit') === 0
                    )
                  } catch {
                    return false
                  }
                })
              const gate = dirty
                ? undefined
                : await runGate(config.gate, worktree.path, process.env, options.signal)
              const failure = [
                ...(dirty ? ['Uncommitted changes'] : []),
                ...(commits.length === 0 && !researchPassed
                  ? ['Interrupted child has no commit']
                  : []),
                ...(gate && gate.exitCode !== 0
                  ? [`Gate exited ${gate.exitCode}: ${gate.output}`]
                  : [])
              ].join('\n')
              if (failure) {
                await bd.recoverClosed(child.id, issue.assignee)
                await executeChild(child.id, {
                  worktree: worktree.path,
                  resume: { start: child.start, failure, owned: worktree.owned }
                })
                deferred = (await epicStatus(bd, epic)).deferred
                continue
              }
              verified = true
              await bd.note(epic, `simmer: verified ${child.id} ${child.branch} ${tip}`)
            }
            result = await git.retryLanding(epic, child.branch, config.push)
          }
        } catch (error) {
          options.signal?.throwIfAborted()
          result = { kind: 'deferred', files: [], reason: errorMessage(error) }
        }
        if (result.kind === 'conflict' || result.kind === 'push-failed') {
          result = { kind: 'deferred', files: [], reason: result.message }
        }
        const tip = integrated ? undefined : await git.branchTip(child.branch)
        await bd.note(
          epic,
          (tip && verified ? `simmer: verified ${child.id} ${child.branch} ${tip}\n` : '') +
            landingNote(child.id, child.branch, result)
        )
        event(result.kind, { id: child.id, branch: child.branch, ...result })
        deferred = (await epicStatus(bd, epic)).deferred
      }
    }
    await bd.reclaimExpired(epic)
    await retryLandings()
    while (!fatal) {
      options.signal?.throwIfAborted()
      const child = (await bd.readyChildren(epic)).find((child) => !attempted.has(child.id))
      if (!child) break
      await executeChild(child.id)
      deferred = (await epicStatus(bd, epic)).deferred
      await retryLandings()
      if (fatal) break
    }
    await retryLandings()
    const status = await epicStatus(bd, epic)
    counts.deferred = status.counts.deferred
    const exitCode = fatal
      ? 1
      : status.counts.blocked || counts.deferred || status.counts.inProgress || counts.errors
        ? 4
        : 0
    event('run-finished', {
      counts,
      exitCode,
      deferred: status.deferred,
      ...(status.inProgress.length
        ? {
            inProgress: status.inProgress,
            resume: 'Rerun after lease expiry to resume these children.'
          }
        : {})
    })
    if (!options.json) {
      for (const child of status.inProgress) {
        process.stdout.write(
          `${child.id}: in progress, lease expires ${child.leaseExpiresAt ?? 'unknown'}\n`
        )
      }
      if (status.inProgress.length) {
        process.stdout.write('Rerun after lease expiry to resume these children.\n')
      }
      for (const child of status.dropped ?? []) {
        process.stdout.write(`Warning: dropped ${child.id}: ${child.reason}\n`)
      }
      for (const child of status.deferred) {
        process.stdout.write(`${child.id}: deferred ${child.branch}: ${child.reason}\n`)
      }
    }
    if (fatal) process.stderr.write(`${fatal}\n`)
    return exitCode
  } catch (error) {
    event('run-finished', {
      counts,
      exitCode: options.signal?.aborted ? (process.exitCode ?? 1) : 1,
      reason: errorMessage(error)
    })
    throw error
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        process.stderr.write(`Lock release: ${errorMessage(error)}\n`)
      }
    }
  }
}

function acquireLock(path: string, epic: string) {
  const candidate = `${path}.${randomUUID()}`
  writeFileSync(candidate, String(process.pid), { flag: 'wx' })
  try {
    while (true) {
      try {
        linkSync(candidate, path)
        return
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      }
      try {
        const existing = statSync(path)
        const pid = Number(readFileSync(path, 'utf8'))
        if (pidIsAlive(pid)) throw new Error(`simmer run ${epic} is already running (pid ${pid})`)
        let recoveryLock = `${path}.reclaim-${existing.ino}`
        while (true) {
          try {
            linkSync(candidate, recoveryLock)
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST')
              throw error
            const recoveryPid = Number(readFileSync(recoveryLock, 'utf8'))
            if (pidIsAlive(recoveryPid)) {
              throw new Error(`simmer run ${epic} is already running (pid ${recoveryPid})`)
            }
            recoveryLock += `-${statSync(recoveryLock).ino}`
            continue
          }
          try {
            if (statSync(path).ino === existing.ino) unlinkSync(path)
            try {
              linkSync(candidate, path)
              return
            } catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST')
                throw error
            }
          } finally {
            unlinkSync(recoveryLock)
          }
          break
        }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      }
    }
  } finally {
    unlinkSync(candidate)
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

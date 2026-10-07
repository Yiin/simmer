import { Bd } from './bd'
import type { LandingResult } from './git'

type DeferredLanding = {
  id: string
  branch: string
  reason: string
  start?: string
  verified?: string
}

export function landingNote(id: string, branch: string, result: LandingResult): string {
  const report = JSON.stringify({ id, branch, ...result })
  if (result.kind === 'landed') return `${report}\nsimmer: landed ${id}`
  if (result.kind !== 'deferred') return report
  const reason =
    result.reason || (result.files.length ? result.files.join(', ') : 'Worktree is busy')
  return `${report}\nsimmer: deferred ${id} ${branch} ${reason.replace(/\s+/g, ' ')}`
}

export function deferredLandings(notes: string, closedIds = new Set<string>()): DeferredLanding[] {
  const deferred = new Map<string, DeferredLanding>()
  const verified = new Map<string, string>()
  for (const line of notes.split('\n')) {
    const checked = /^simmer: verified (\S+) (\S+) ([a-f0-9]+)$/.exec(line)
    if (checked?.[1] && checked[2] && checked[3]) {
      verified.set(checked[1], checked[3])
      deferred.set(checked[1], {
        id: checked[1],
        branch: checked[2],
        verified: checked[3],
        reason: deferred.get(checked[1])?.reason ?? 'Landing was interrupted'
      })
    }
    const landed = /^simmer: (?:landed|stopped|dropped) (\S+)(?: .+)?$/.exec(line)
    if (landed?.[1]) {
      deferred.delete(landed[1])
      verified.delete(landed[1])
    }
    const pending = /^simmer: deferred (\S+) (\S+) (.+)$/.exec(line)
    if (pending?.[1] && pending[2] && pending[3]) {
      deferred.set(pending[1], {
        id: pending[1],
        branch: pending[2],
        reason: pending[3],
        ...(verified.has(pending[1])
          ? { verified: verified.get(pending[1]) }
          : deferred.get(pending[1])?.start
            ? { start: deferred.get(pending[1])?.start }
            : {})
      })
    }
    const working = /^simmer: working (\S+) (\S+) ([a-f0-9]+)$/.exec(line)
    if (working?.[1]) verified.delete(working[1])
    if (working?.[1] && working[2] && working[3] && closedIds.has(working[1])) {
      deferred.set(working[1], {
        id: working[1],
        branch: working[2],
        reason: deferred.get(working[1])?.reason ?? 'Child verification was interrupted',
        start: working[3]
      })
    }
  }
  return [...deferred.values()]
}

export async function epicStatus(bd: Bd, epic: string) {
  const [issue, children, readyChildren] = await Promise.all([
    bd.show(epic),
    bd.children(epic),
    bd.readyChildren(epic)
  ])
  const readyIds = new Set(readyChildren.map((child) => child.id))
  const closed: string[] = []
  const blocked: string[] = []
  const inProgress: { id: string; assignee: string; lease: string; leaseExpiresAt?: string }[] = []
  const ready: string[] = []
  const waiting: string[] = []
  for (const child of children) {
    if (child.status === 'closed') closed.push(child.id)
    else if (child.status === 'blocked') blocked.push(child.id)
    else if (child.status === 'in_progress') {
      const expiration = Date.parse(child.leaseExpiresAt ?? '')
      inProgress.push({
        id: child.id,
        assignee: child.assignee,
        lease: Number.isNaN(expiration)
          ? 'unknown'
          : expiration <= Date.now()
            ? 'expired'
            : 'active',
        ...(child.leaseExpiresAt ? { leaseExpiresAt: child.leaseExpiresAt } : {})
      })
    } else if (readyIds.has(child.id)) ready.push(child.id)
    else waiting.push(child.id)
  }
  const deferred = deferredLandings(issue.notes, new Set(closed))
  const dropped = issue.notes.split('\n').flatMap((line) => {
    const match = /^simmer: dropped (\S+) (.+)$/.exec(line)
    return match?.[1] && match[2] ? [{ id: match[1], reason: match[2] }] : []
  })
  return {
    epic,
    counts: {
      closed: closed.length,
      blocked: blocked.length,
      inProgress: inProgress.length,
      ready: ready.length,
      waiting: waiting.length,
      deferred: deferred.length
    },
    closed,
    blocked,
    inProgress,
    ready,
    waiting,
    deferred,
    ...(dropped.length ? { dropped } : {})
  }
}

export async function printStatus(options: { epic: string; cwd: string; json?: boolean }) {
  const status = await epicStatus(
    new Bd({ cwd: options.cwd, actor: 'simmer-status' }),
    options.epic
  )
  if (options.json) {
    process.stdout.write(`${JSON.stringify(status)}\n`)
    return
  }
  const groups = [
    ['Closed', status.closed],
    ['Blocked', status.blocked],
    [
      'In progress',
      status.inProgress.map(
        (child) => `${child.id} (assignee: ${child.assignee || 'none'}, lease: ${child.lease})`
      )
    ],
    ['Ready', status.ready],
    ['Waiting on dependencies', status.waiting],
    [
      'Deferred landings',
      status.deferred.map((child) => `${child.id} (${child.branch}: ${child.reason})`)
    ]
  ] satisfies [string, string[]][]
  process.stdout.write(
    `${status.epic}\n${groups
      .map(
        ([label, children]) =>
          `${label}: ${children.length}${children.length ? ` ${children.join(', ')}` : ''}`
      )
      .join('\n')}\n`
  )
  for (const child of status.dropped ?? []) {
    process.stdout.write(`Warning: dropped ${child.id}: ${child.reason}\n`)
  }
}

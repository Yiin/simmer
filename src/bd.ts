export type Issue = {
  id: string
  title: string
  status: string
  description: string
  acceptanceCriteria: string
  notes: string
  assignee: string
  labels: string[]
  comments: { id: string; text: string }[]
  parent?: string
  leaseExpiresAt?: string
}

export type ClaimResult = { kind: 'claimed' } | { kind: 'lost' }

export class BdError extends Error {
  constructor(
    command: string,
    readonly exitCode: number,
    output: string
  ) {
    super(`bd ${command} failed (exit ${exitCode}): ${output.trim()}`)
    this.name = 'BdError'
  }
}

function issue(value: unknown): Issue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid bd JSON: issue must be an object')
  }
  const fields = value
  function text(field: string, required = false): string {
    const entry: unknown = Reflect.get(fields, field)
    if (entry === undefined && !required) return ''
    if (typeof entry !== 'string' || (required && entry.trim() === '')) {
      throw new Error(`Invalid bd JSON: ${field} must be a string`)
    }
    return entry
  }
  const labels: unknown = Reflect.get(fields, 'labels') ?? []
  if (!Array.isArray(labels) || !labels.every((label: unknown) => typeof label === 'string')) {
    throw new Error('Invalid bd JSON: labels must be strings')
  }
  const comments: unknown = Reflect.get(fields, 'comments') ?? []
  if (!Array.isArray(comments)) throw new Error('Invalid bd JSON: comments must be an array')
  return {
    id: text('id', true),
    title: text('title', true),
    status: text('status', true),
    description: text('description'),
    acceptanceCriteria: text('acceptance_criteria'),
    notes: text('notes'),
    assignee: text('assignee'),
    labels,
    comments: comments.map((comment: unknown) => {
      if (typeof comment !== 'object' || comment === null) {
        throw new Error('Invalid bd JSON: comment must be an object')
      }
      const id: unknown = Reflect.get(comment, 'id')
      const text: unknown = Reflect.get(comment, 'text')
      if (typeof id !== 'string' || typeof text !== 'string') {
        throw new Error('Invalid bd JSON: comment needs a string id and text')
      }
      return { id, text }
    }),
    ...(text('parent') ? { parent: identifier(text('parent')) } : {}),
    ...(text('lease_expires_at') ? { leaseExpiresAt: text('lease_expires_at') } : {})
  }
}

function issues(output: string): Issue[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('Invalid bd JSON: expected an issue array')
  }
  if (!Array.isArray(parsed)) throw new Error('Invalid bd JSON: expected an issue array')
  return parsed.map(issue)
}

function identifier(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid bd issue ID: ${value}`)
  }
  return value
}

// Only a simmer worker's actor (`<name>-<uuid>`, see child.ts) is safe to clear or reclaim. A
// person's claim has a lease too, but nobody heartbeats it, so it expires while they still work.
const simmerActor = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class Bd {
  private readonly cwd: string
  private readonly actor: string
  private readonly timeoutMs: number
  private readonly signal?: AbortSignal

  constructor(options: { cwd: string; actor: string; timeoutMs?: number; signal?: AbortSignal }) {
    if (options.actor.trim() === '') throw new Error('bd actor must be a non-empty string')
    this.cwd = options.cwd
    this.actor = options.actor
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.signal = options.signal
  }

  private async run(commandArguments: string[], input = ''): Promise<string> {
    this.signal?.throwIfAborted()
    const child = Bun.spawn(['bd', ...commandArguments, '--json', '--actor', this.actor], {
      cwd: this.cwd,
      detached: true,
      env: process.env,
      stdin: new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'pipe'
    })
    let timedOut = false
    function kill() {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, this.timeoutMs)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
      ])
      this.signal?.throwIfAborted()
      if (timedOut) {
        throw new BdError(commandArguments[0] ?? '', 124, `timed out after ${this.timeoutMs}ms`)
      }
      if (exitCode !== 0) {
        throw new BdError(commandArguments[0] ?? '', exitCode, stderr || stdout)
      }
      return stdout
    } finally {
      clearTimeout(timer)
    }
  }

  async children(epic: string): Promise<Issue[]> {
    return issues(await this.run(['list', '--parent', identifier(epic), '--all', '--limit', '0']))
  }

  async readyChildren(epic: string): Promise<Issue[]> {
    return issues(await this.run(['list', '--parent', identifier(epic), '--ready', '--limit', '0']))
  }

  async show(id: string, includeComments = false): Promise<Issue> {
    const result = issues(
      await this.run(['show', identifier(id), ...(includeComments ? ['--include-comments'] : [])])
    )
    const found = result[0]
    if (result.length !== 1 || found?.id !== id) {
      throw new Error(`Invalid bd JSON: expected issue ${id}`)
    }
    return found
  }

  async isClosed(id: string): Promise<boolean> {
    return (await this.show(id)).status === 'closed'
  }

  async claim(id: string): Promise<ClaimResult> {
    try {
      await this.run(['update', identifier(id), '--claim'])
    } catch (error) {
      // bd 1.3.1 reports a claim held by another actor as exit 1, not the exit 13 of a guard.
      if (
        error instanceof BdError &&
        (error.exitCode === 13 || /already (?:claimed by|assigned to)/.test(error.message))
      ) {
        return { kind: 'lost' }
      }
      throw error
    }
    return { kind: 'claimed' }
  }

  async heartbeat(id: string): Promise<void> {
    await this.run(['heartbeat', identifier(id)])
  }

  async reopen(id: string, reason: string, resume = true): Promise<void> {
    await this.run(['reopen', identifier(id), '--reason', reason])
    if (resume) await this.run(['update', identifier(id), '--claim'])
  }

  async block(id: string): Promise<void> {
    await this.run([
      'update',
      identifier(id),
      '--status',
      'blocked',
      '--assignee',
      '',
      '--if-assignee',
      this.actor
    ])
  }

  async unclaim(id: string): Promise<void> {
    await this.run(['unclaim', identifier(id), '--if-assignee', this.actor])
  }

  async recoverClosed(id: string, assignee: string): Promise<void> {
    await this.run([
      'update',
      identifier(id),
      '--status',
      'open',
      '--assignee',
      '',
      '--if-status',
      'closed',
      '--if-assignee',
      assignee
    ])
  }

  async note(id: string, text: string): Promise<void> {
    await this.run(['note', identifier(id), '--stdin'], text)
  }

  async reclaimExpired(epic: string): Promise<void> {
    const children = await this.children(epic)
    for (const child of children) {
      if (
        child.status === 'open' &&
        simmerActor.test(child.assignee) &&
        !(Date.parse(child.leaseExpiresAt ?? '') > Date.now())
      ) {
        try {
          await this.run([
            'update',
            identifier(child.id),
            '--assignee',
            '',
            '--if-status',
            'open',
            '--if-assignee',
            child.assignee
          ])
        } catch (error) {
          if (!(error instanceof BdError) || error.exitCode !== 13) throw error
        }
        continue
      }
      if (
        child.status !== 'in_progress' ||
        child.leaseExpiresAt ||
        (child.assignee !== '' && child.assignee !== this.actor)
      )
        continue
      try {
        await this.run([
          'update',
          identifier(child.id),
          '--status',
          'open',
          '--assignee',
          '',
          '--if-status',
          'in_progress',
          '--if-assignee',
          child.assignee
        ])
      } catch (error) {
        if (!(error instanceof BdError) || error.exitCode !== 13) throw error
      }
    }
    const ids = children
      .filter(
        (child) =>
          child.status === 'in_progress' && child.leaseExpiresAt && simmerActor.test(child.assignee)
      )
      .map((child) => child.id)
    if (ids.length === 0) return
    await this.run(['reclaim', '--id', ids.map(identifier).join(','), '--older-than', '0s'])
  }
}

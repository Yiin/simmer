export type Issue = {
  id: string
  title: string
  status: string
  description: string
  acceptanceCriteria: string
  notes: string
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
  return {
    id: text('id', true),
    title: text('title', true),
    status: text('status', true),
    description: text('description'),
    acceptanceCriteria: text('acceptance_criteria'),
    notes: text('notes')
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

export class Bd {
  private readonly cwd: string
  private readonly actor: string

  constructor(options: { cwd: string; actor: string }) {
    if (options.actor.trim() === '') throw new Error('bd actor must be a non-empty string')
    this.cwd = options.cwd
    this.actor = options.actor
  }

  private async run(commandArguments: string[], input = ''): Promise<string> {
    const child = Bun.spawn(['bd', ...commandArguments, '--json', '--actor', this.actor], {
      cwd: this.cwd,
      env: process.env,
      stdin: new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    if (exitCode !== 0) {
      throw new BdError(commandArguments[0] ?? '', exitCode, stderr || stdout)
    }
    return stdout
  }

  async children(epic: string): Promise<Issue[]> {
    return issues(await this.run(['list', '--parent', identifier(epic), '--all', '--limit', '0']))
  }

  async readyChildren(epic: string): Promise<Issue[]> {
    return issues(await this.run(['list', '--parent', identifier(epic), '--ready', '--limit', '0']))
  }

  async show(id: string): Promise<Issue> {
    const result = issues(await this.run(['show', identifier(id)]))
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
      if (error instanceof BdError && /already claimed|held by/.test(error.message)) {
        return { kind: 'lost' }
      }
      throw error
    }
    return { kind: 'claimed' }
  }

  async heartbeat(id: string): Promise<void> {
    await this.run(['heartbeat', identifier(id)])
  }

  async unclaim(id: string): Promise<void> {
    await this.run(['unclaim', identifier(id), '--if-assignee', this.actor])
  }

  async note(id: string, text: string): Promise<void> {
    await this.run(['note', identifier(id), '--stdin'], text)
  }

  async reclaimExpired(epic: string): Promise<void> {
    const children = await this.children(epic)
    const ids = children.filter((child) => child.status === 'in_progress').map((child) => child.id)
    if (ids.length === 0) return
    await this.run(['reclaim', '--id', ids.map(identifier).join(','), '--older-than', '0s'])
  }
}

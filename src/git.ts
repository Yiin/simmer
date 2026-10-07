import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type Worktree = {
  path: string
  branch: string
  runBranch: string
  start: string
  owned: boolean
}

export type LandingResult = (
  | { kind: 'landed' }
  | { kind: 'deferred'; files: string[]; reason?: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'push-failed'; message: string }
) & { cleanupError?: string }

export class GitError extends Error {
  constructor(
    command: string,
    readonly exitCode: number,
    output: string
  ) {
    super(`git ${command} failed (exit ${exitCode}): ${output.trim()}`)
    this.name = 'GitError'
  }
}

export class Git {
  constructor(private readonly options: { cwd: string; base: string }) {}

  async temporaryDirectory(): Promise<string> {
    const directory = (
      await this.run(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim()
    const temporaryDirectory = join(directory, 'simmer-tmp')
    mkdirSync(temporaryDirectory, { recursive: true })
    return temporaryDirectory
  }

  async recoverWorktree(epic: string, branch: string, start = ''): Promise<Worktree> {
    await this.run(['check-ref-format', '--branch', branch])
    let checkout = await this.branchWorktree(branch)
    if (checkout?.busy) throw new Error('Child worktree is busy')
    const temporaryDirectory = await this.temporaryDirectory()
    if (!checkout && (await this.run(['branch', '--list', branch])).trim() !== '') {
      const path = mkdtempSync(join(temporaryDirectory, 'child-'))
      await this.run(['worktree', 'add', '--', path, branch])
      checkout = { path, busy: false }
    }
    return {
      path: checkout?.path ?? this.options.cwd,
      branch,
      runBranch: `simmer/${epic}`,
      start,
      owned: checkout?.path.startsWith(`${temporaryDirectory}/child-`) ?? false
    }
  }

  async branchTip(branch: string): Promise<string | undefined> {
    await this.run(['check-ref-format', '--branch', branch])
    try {
      return (await this.run(['rev-parse', '--verify', `refs/heads/${branch}`])).trim()
    } catch (error) {
      if (!(error instanceof GitError) || error.exitCode !== 128) throw error
      return undefined
    }
  }

  async isIntegrated(epic: string, commit: string): Promise<boolean> {
    for (const branch of [`simmer/${epic}`, this.options.base]) {
      const tip = await this.branchTip(branch)
      if (!tip) continue
      try {
        await this.run(['merge-base', '--is-ancestor', commit, tip])
        return true
      } catch (error) {
        if (!(error instanceof GitError) || error.exitCode !== 1) throw error
      }
    }
    return false
  }

  async landRun(epic: string, push = false): Promise<LandingResult> {
    const runBranch = `simmer/${epic}`
    if (!(await this.branchTip(runBranch))) return { kind: 'landed' }
    return this.land(
      {
        path: this.options.cwd,
        branch: runBranch,
        runBranch,
        start: '',
        owned: false
      },
      push
    )
  }

  async retryLanding(epic: string, branch: string, push = false): Promise<LandingResult> {
    const worktree = await this.recoverWorktree(epic, branch)
    if (worktree.path !== this.options.cwd) {
      const integrated = await this.integrate(worktree)
      if (integrated.kind !== 'landed') return integrated
    }
    return this.land(worktree, push)
  }

  private async run(commandArguments: string[], cwd = this.options.cwd): Promise<string> {
    const child = Bun.spawn(
      ['git', '-c', 'rebase.autoStash=false', '-c', 'merge.autoStash=false', ...commandArguments],
      { cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    if (exitCode !== 0) {
      throw new GitError(commandArguments[0] ?? '', exitCode, stderr || stdout)
    }
    return stdout
  }

  async createWorktree(options: {
    epic: string
    path?: string
    adopt?: boolean
    branch?: string
  }): Promise<Worktree> {
    const runBranch = `simmer/${options.epic}`
    await this.run(['check-ref-format', '--branch', runBranch])
    await this.run(['check-ref-format', '--branch', this.options.base])
    let path: string
    if (options.path) {
      path = resolve(options.path)
    } else {
      const gitDirectory = (
        await this.run(['rev-parse', '--path-format=absolute', '--git-common-dir'])
      ).trim()
      const temporaryDirectory = join(gitDirectory, 'simmer-tmp')
      mkdirSync(temporaryDirectory, { recursive: true })
      path = mkdtempSync(join(temporaryDirectory, 'child-'))
    }
    let branch = options.branch ?? `${runBranch}-child-${randomUUID()}`
    if (options.adopt) {
      const commonDirectory = resolve(
        path,
        (await this.run(['rev-parse', '--git-common-dir'], path)).trim()
      )
      const projectDirectory = resolve(
        this.options.cwd,
        (await this.run(['rev-parse', '--git-common-dir'])).trim()
      )
      if (commonDirectory !== projectDirectory) throw new Error('Worktree belongs to another repo')
      branch = (await this.run(['symbolic-ref', '--short', 'HEAD'], path)).trim()
      if (branch === this.options.base) throw new Error('Cannot adopt the base branch worktree')
      if (branch === runBranch) throw new Error('Cannot adopt the run branch worktree')
    }
    if ((await this.run(['branch', '--list', runBranch])).trim() === '') {
      await this.run(['branch', runBranch, `refs/heads/${this.options.base}`])
    }
    if (!options.adopt) {
      await this.run(['worktree', 'add', '--track', '-b', branch, '--', path, runBranch])
    }
    return {
      path,
      branch,
      runBranch,
      start: (await this.run(['rev-parse', 'HEAD'], path)).trim(),
      owned: !options.adopt
    }
  }

  async newCommits(worktree: Worktree): Promise<string[]> {
    const branch = (await this.run(['symbolic-ref', '--short', 'HEAD'], worktree.path)).trim()
    if (branch !== worktree.branch) throw new Error('Worker changed the worktree branch')
    const output = await this.run(
      ['rev-list', '--reverse', `${worktree.start}..HEAD`],
      worktree.path
    )
    return output.trim() === '' ? [] : output.trim().split('\n')
  }

  async hasUncommittedChanges(worktree: Worktree): Promise<boolean> {
    return (await this.run(['status', '--porcelain'], worktree.path)).trim() !== ''
  }

  private async branchWorktree(
    branch: string
  ): Promise<{ path: string; busy: boolean } | undefined> {
    await this.run(['worktree', 'prune', '--expire', '3.months.ago'])
    const worktrees = await this.run(['worktree', 'list', '--porcelain', '-z'])
    let checkout: { path: string; busy: boolean } | undefined
    for (const record of worktrees.split('\0\0')) {
      const fields = record.split('\0')
      const worktreeField = fields.find((field) => field.startsWith('worktree '))
      if (!worktreeField) continue
      const path = worktreeField.slice('worktree '.length)
      const hasBranch = fields.includes(`branch refs/heads/${branch}`)
      if (fields.some((field) => field === 'prunable' || field.startsWith('prunable '))) {
        if (hasBranch) return { path, busy: true }
        continue
      }
      let gitDirectory: string
      try {
        gitDirectory = (await this.run(['rev-parse', '--absolute-git-dir'], path)).trim()
      } catch {
        return { path, busy: true }
      }
      for (const file of ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']) {
        const statePath = join(gitDirectory, file)
        if (!existsSync(statePath)) continue
        const name = readFileSync(statePath, 'utf8').trim()
        if (name === branch || name === `refs/heads/${branch}`) return { path, busy: true }
      }
      if (hasBranch) {
        const busy = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_START'].some((file) =>
          existsSync(join(gitDirectory, file))
        )
        if (busy) return { path, busy }
        checkout = { path, busy }
      }
    }
    return checkout
  }

  private async overlappingFiles(path: string, oldTip: string, newTip: string): Promise<string[]> {
    const incoming = (
      await this.run(['diff', '--name-only', '-z', '--no-renames', `${oldTip}..${newTip}`])
    )
      .split('\0')
      .filter(Boolean)
    const status = (
      await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'], path)
    ).split('\0')
    const dirty: string[] = []
    for (let index = 0; index < status.length; index++) {
      const record = status[index]
      if (!record) continue
      dirty.push(record.slice(3))
      if (/[RC]/.test(record.slice(0, 2))) {
        const original = status[++index]
        if (original) dirty.push(original)
      }
    }
    return [...new Set(dirty)]
      .filter((file) =>
        incoming.some(
          (changed) =>
            changed === file || changed.startsWith(`${file}/`) || file.startsWith(`${changed}/`)
        )
      )
      .sort()
  }

  private async advance(branch: string, sourceBranch: string): Promise<LandingResult> {
    const oldTip = (await this.run(['rev-parse', `refs/heads/${branch}`])).trim()
    const newTip = (await this.run(['rev-parse', `refs/heads/${sourceBranch}`])).trim()
    const checkout = await this.branchWorktree(branch)
    if (checkout?.busy) return { kind: 'deferred', files: [] }
    try {
      await this.run(['merge-base', '--is-ancestor', oldTip, newTip])
    } catch (error) {
      if (!(error instanceof GitError) || error.exitCode !== 1) throw error
      return { kind: 'conflict', message: error.message }
    }
    if (!checkout) {
      await this.run(['update-ref', `refs/heads/${branch}`, newTip, oldTip])
      return { kind: 'landed' }
    }
    const files = await this.overlappingFiles(checkout.path, oldTip, newTip)
    if (files.length > 0) return { kind: 'deferred', files }
    try {
      await this.run(
        ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', newTip],
        checkout.path
      )
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      return {
        kind: 'deferred',
        files: await this.overlappingFiles(checkout.path, oldTip, newTip),
        reason: error.message
      }
    }
    if ((await this.run(['rev-parse', 'HEAD'], checkout.path)).trim() !== newTip) {
      throw new Error('HEAD changed during landing')
    }
    return { kind: 'landed' }
  }

  private async rebase(path: string, target: string): Promise<LandingResult> {
    try {
      await this.run(['rebase', target], path)
      return { kind: 'landed' }
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      const gitDirectory = (await this.run(['rev-parse', '--absolute-git-dir'], path)).trim()
      if (['rebase-merge', 'rebase-apply'].some((file) => existsSync(join(gitDirectory, file)))) {
        await this.run(['rebase', '--abort'], path)
      }
      return { kind: 'conflict', message: error.message }
    }
  }

  async integrate(worktree: Worktree): Promise<LandingResult> {
    const branch = (await this.run(['symbolic-ref', '--short', 'HEAD'], worktree.path)).trim()
    if (branch !== worktree.branch) throw new Error('Worker changed the worktree branch')
    const result = await this.rebase(worktree.path, `refs/heads/${worktree.runBranch}`)
    if (result.kind !== 'landed') return result
    return this.advance(worktree.runBranch, branch)
  }

  async land(worktree: Worktree, push = false): Promise<LandingResult> {
    if ((await this.branchWorktree(this.options.base))?.busy) {
      return { kind: 'deferred', files: [] }
    }
    let cleanupError: string | undefined
    let rebasedRun = false
    try {
      await this.run([
        'merge-base',
        '--is-ancestor',
        `refs/heads/${this.options.base}`,
        `refs/heads/${worktree.runBranch}`
      ])
    } catch (error) {
      if (!(error instanceof GitError) || error.exitCode !== 1) throw error
      const oldTip = (await this.run(['rev-parse', `refs/heads/${worktree.runBranch}`])).trim()
      const gitDirectory = (
        await this.run(['rev-parse', '--path-format=absolute', '--git-common-dir'])
      ).trim()
      const temporaryDirectory = join(gitDirectory, 'simmer-tmp')
      mkdirSync(temporaryDirectory, { recursive: true })
      const path = mkdtempSync(join(temporaryDirectory, 'rebase-'))
      let rebaseResult: LandingResult
      let added = false
      try {
        await this.run(['worktree', 'add', '--detach', '--', path, oldTip])
        added = true
        rebaseResult = await this.rebase(path, `refs/heads/${this.options.base}`)
        if (rebaseResult.kind === 'landed') {
          const newTip = (await this.run(['rev-parse', 'HEAD'], path)).trim()
          await this.run(['update-ref', `refs/heads/${worktree.runBranch}`, newTip, oldTip])
          rebasedRun = true
        }
      } finally {
        if (added) {
          try {
            await this.run(['worktree', 'remove', '--', path])
          } catch (cleanupFailure) {
            cleanupError =
              cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)
          }
        } else {
          rmSync(path, { recursive: true, force: true })
        }
      }
      if (rebaseResult.kind !== 'landed') {
        return cleanupError ? { ...rebaseResult, cleanupError } : rebaseResult
      }
    }
    const result = await this.advance(this.options.base, worktree.runBranch)
    if (result.kind !== 'landed') return cleanupError ? { ...result, cleanupError } : result
    if (push) {
      try {
        await this.run(['push', 'origin', `refs/heads/${this.options.base}`])
      } catch (error) {
        if (!(error instanceof GitError)) throw error
        const failure: LandingResult = { kind: 'push-failed', message: error.message }
        return cleanupError ? { ...failure, cleanupError } : failure
      }
    }
    try {
      if (worktree.owned && rebasedRun) {
        const result = await this.rebase(worktree.path, `refs/heads/${worktree.runBranch}`)
        if (result.kind !== 'landed') throw new Error('Child cleanup rebase failed')
      }
      await this.cleanupWorktree(worktree)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cleanupError = [cleanupError, message].filter(Boolean).join('\n')
    }
    return cleanupError ? { ...result, cleanupError } : result
  }

  async removeWorktree(worktree: Worktree): Promise<void> {
    if (worktree.owned) await this.run(['worktree', 'remove', '--', worktree.path])
  }

  async cleanupWorktree(worktree: Worktree): Promise<void> {
    if (!worktree.owned) return
    await this.removeWorktree(worktree)
    await this.run(['branch', '-d', '--', worktree.branch])
  }
}

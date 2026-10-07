import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Git, GitError, type Worktree } from '../src/git'

let directory: string
let repository: string
let adapter: Git
let originalPath: string | undefined

async function git(commandArguments: string[], cwd = repository): Promise<string> {
  const child = Bun.spawn(['git', ...commandArguments], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function commit(path: string, file: string, contents: string): Promise<string> {
  writeFileSync(join(path, file), contents)
  await git(['add', '--', file], path)
  await git(['commit', '-m', file], path)
  return git(['rev-parse', 'HEAD'], path)
}

async function worker(): Promise<Worktree> {
  return adapter.createWorktree({ epic: 'epic-1', path: join(directory, 'worker checkout') })
}

async function integrateAndLand(worktree: Worktree, push = false) {
  expect(await adapter.integrate(worktree)).toEqual({ kind: 'landed' })
  return adapter.land(worktree, push)
}

async function interceptGit(body: string): Promise<void> {
  const binary = Bun.which('git')
  if (!binary) throw new Error('git is required for these tests')
  const binaries = join(directory, 'binaries')
  mkdirSync(binaries)
  writeFileSync(
    join(binaries, 'git'),
    `#!${process.execPath}
const argumentsList = process.argv.slice(2)
async function run(commandArguments) {
  const child = Bun.spawn([${JSON.stringify(binary)}, ...commandArguments], {
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit'
  })
  return child.exited
}
${body}
process.exit(await run(argumentsList))
`,
    { mode: 0o755 }
  )
  process.env.PATH = `${binaries}:${originalPath ?? ''}`
}

beforeEach(async () => {
  directory = mkdtempSync('/tmp/simmer git-test-')
  repository = join(directory, 'primary checkout')
  mkdirSync(repository)
  originalPath = process.env.PATH
  adapter = new Git({ cwd: repository, base: 'main' })
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 't'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'commit.gpgsign', 'false'])
  await commit(repository, 'shared.txt', 'original\n')
  await commit(repository, 'local.txt', 'local original\n')
})

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(directory, { recursive: true, force: true })
})

test('creates a worktree at the run branch tip and lists new commits in order', async () => {
  const worktree = await worker()
  expect(worktree.path).toBe(join(directory, 'worker checkout'))
  expect(worktree.branch.startsWith('simmer/epic-1-child-')).toBe(true)
  expect(worktree.runBranch).toBe('simmer/epic-1')
  expect(worktree.owned).toBe(true)
  expect(await adapter.newCommits(worktree)).toEqual([])
  const first = await commit(worktree.path, 'first.txt', 'first\n')
  const second = await commit(worktree.path, 'second.txt', 'second\n')
  expect(await adapter.newCommits(worktree)).toEqual([first, second])
  expect(await adapter.integrate(worktree)).toEqual({ kind: 'landed' })
  await adapter.removeWorktree(worktree)
  const next = await worker()
  expect(next.start).toBe(second)
  expect(readFileSync(join(next.path, 'second.txt'), 'utf8')).toBe('second\n')
})

test('lands through a ref update when no worktree has base checked out', async () => {
  const worktree = await worker()
  const tip = await commit(worktree.path, 'shared.txt', 'incoming\n')
  await git(['switch', '-c', 'other'])
  writeFileSync(join(repository, 'shared.txt'), 'primary dirty\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['rev-parse', 'main'])).toBe(tip)
  expect(await git(['branch', '--show-current'])).toBe('other')
  expect(readFileSync(join(repository, 'shared.txt'), 'utf8')).toBe('primary dirty\n')
  expect(existsSync(worktree.path)).toBe(false)
  expect(await git(['branch', '--list', worktree.branch])).toBe('')
})

test.each(['unstaged', 'staged', 'untracked'])(
  'lands with an unrelated $0 file and keeps the local change',
  async (state) => {
    const worktree = await worker()
    const tip = await commit(worktree.path, 'shared.txt', 'incoming\n')
    const file = state === 'untracked' ? 'notes.txt' : 'local.txt'
    writeFileSync(join(repository, file), 'local change\n')
    if (state === 'staged') await git(['add', '--', file])
    const status = await git(['status', '--porcelain=v1'])
    expect(await integrateAndLand(worktree)).toEqual({ kind: 'landed' })
    expect(await git(['rev-parse', 'main'])).toBe(tip)
    expect(readFileSync(join(repository, 'shared.txt'), 'utf8')).toBe('incoming\n')
    expect(readFileSync(join(repository, file), 'utf8')).toBe('local change\n')
    expect(await git(['status', '--porcelain=v1'])).toBe(status)
  }
)

test('defers overlap, allows more commits, and lands on retry after the dirty change is gone', async () => {
  const original = await git(['rev-parse', 'main'])
  const worktree = await worker()
  await commit(worktree.path, 'shared.txt', 'incoming\n')
  writeFileSync(join(repository, 'shared.txt'), 'primary dirty\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'deferred', files: ['shared.txt'] })
  expect(await git(['rev-parse', 'main'])).toBe(original)
  expect(readFileSync(join(repository, 'shared.txt'), 'utf8')).toBe('primary dirty\n')
  expect(existsSync(worktree.path)).toBe(true)
  expect(await git(['rev-parse', worktree.branch])).toBe(
    await git(['rev-parse', worktree.runBranch])
  )
  const tip = await commit(worktree.path, 'next.txt', 'next child\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'deferred', files: ['shared.txt'] })
  writeFileSync(join(repository, 'shared.txt'), 'original\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['rev-parse', 'main'])).toBe(tip)
  expect(readFileSync(join(repository, 'next.txt'), 'utf8')).toBe('next child\n')
  expect(existsSync(worktree.path)).toBe(false)
})

test('defers staged overlap', async () => {
  const worktree = await worker()
  await commit(worktree.path, 'shared.txt', 'incoming\n')
  writeFileSync(join(repository, 'shared.txt'), 'staged local\n')
  await git(['add', 'shared.txt'])
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'deferred', files: ['shared.txt'] })
  expect(await git(['show', ':shared.txt'])).toBe('staged local')
})

test('defers an incoming file that overlaps an untracked file', async () => {
  const worktree = await worker()
  await commit(worktree.path, 'new.txt', 'incoming\n')
  writeFileSync(join(repository, 'new.txt'), 'untracked local\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'deferred', files: ['new.txt'] })
  expect(readFileSync(join(repository, 'new.txt'), 'utf8')).toBe('untracked local\n')
})

test('defers an incoming file that replaces an untracked directory', async () => {
  const worktree = await worker()
  await commit(worktree.path, 'new', 'incoming\n')
  mkdirSync(join(repository, 'new'))
  writeFileSync(join(repository, 'new', 'local.txt'), 'untracked local\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'deferred', files: ['new/local.txt'] })
})

test('defers an incoming directory that replaces an untracked file', async () => {
  const worktree = await worker()
  mkdirSync(join(worktree.path, 'new'))
  await commit(worktree.path, 'new/incoming.txt', 'incoming\n')
  writeFileSync(join(repository, 'new'), 'untracked local\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'deferred', files: ['new'] })
})

test('reports both sides of a staged rename without losing the original path', async () => {
  const worktree = await worker()
  await commit(worktree.path, 'shared.txt', 'incoming\n')
  await git(['mv', 'shared.txt', 'renamed.txt'])
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'deferred', files: ['shared.txt'] })
  expect(readFileSync(join(repository, 'renamed.txt'), 'utf8')).toBe('original\n')
})

test('reports sorted literal paths with spaces, tabs, and newlines', async () => {
  const worktree = await worker()
  for (const file of ['z space.txt', 'a\tline\nfile.txt']) {
    await commit(worktree.path, file, 'incoming\n')
    writeFileSync(join(repository, file), 'untracked local\n')
  }
  expect(await integrateAndLand(worktree)).toEqual({
    kind: 'deferred',
    files: ['a\tline\nfile.txt', 'z space.txt']
  })
})

test('finds base in another worktree, including a path with a newline', async () => {
  const worktree = await worker()
  const tip = await commit(worktree.path, 'shared.txt', 'incoming\n')
  await git(['switch', '-c', 'other'])
  writeFileSync(join(repository, 'shared.txt'), 'primary dirty\n')
  const basePath = join(directory, 'base checkout\nsecond line')
  await git(['worktree', 'add', basePath, 'main'])
  writeFileSync(join(basePath, 'local.txt'), 'base dirty\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['rev-parse', 'HEAD'], basePath)).toBe(tip)
  expect(readFileSync(join(basePath, 'shared.txt'), 'utf8')).toBe('incoming\n')
  expect(readFileSync(join(basePath, 'local.txt'), 'utf8')).toBe('base dirty\n')
  expect(readFileSync(join(repository, 'shared.txt'), 'utf8')).toBe('primary dirty\n')
})

test('detects overlap in the worktree that has base checked out', async () => {
  const worktree = await worker()
  await commit(worktree.path, 'shared.txt', 'incoming\n')
  await git(['switch', '-c', 'other'])
  const basePath = join(directory, 'base checkout')
  await git(['worktree', 'add', basePath, 'main'])
  writeFileSync(join(basePath, 'shared.txt'), 'base dirty\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'deferred', files: ['shared.txt'] })
  expect(readFileSync(join(basePath, 'shared.txt'), 'utf8')).toBe('base dirty\n')
})

test.each([true, false])(
  'rebases the run tip after base moved, checked out: %s',
  async (checkedOut) => {
    const worktree = await worker()
    await commit(worktree.path, 'child.txt', 'child\n')
    const baseTip = await commit(repository, 'base.txt', 'base moved\n')
    writeFileSync(join(repository, 'local.txt'), 'primary dirty\n')
    if (!checkedOut) await git(['switch', '-c', 'other'])
    expect(await integrateAndLand(worktree)).toEqual({ kind: 'landed' })
    expect(await git(['log', '-2', '--format=%s', 'main'])).toBe('child.txt\nbase.txt')
    expect(await git(['rev-parse', 'main^'])).toBe(baseTip)
    expect(await git(['rev-parse', 'main'])).toBe(await git(['rev-parse', 'simmer/epic-1']))
    expect(readFileSync(join(repository, 'local.txt'), 'utf8')).toBe('primary dirty\n')
    expect(await git(['show', 'main:child.txt'])).toBe('child')
    expect(await git(['show', 'main:base.txt'])).toBe('base moved')
    expect(await git(['branch', '--list', worktree.branch])).toBe('')
  }
)

test('keeps a base commit when base is already ahead of the run branch', async () => {
  const worktree = await worker()
  const baseTip = await commit(repository, 'base.txt', 'base moved\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['rev-parse', 'main'])).toBe(baseTip)
  expect(await git(['rev-parse', 'simmer/epic-1'])).toBe(baseTip)
})

test('adopts an orchestrator worktree, integrates its branch, and preserves its path', async () => {
  const worktreePath = join(directory, 'assigned checkout')
  await git(['worktree', 'add', '-b', 'assigned', worktreePath, 'main'])
  const worktree = await adapter.createWorktree({
    epic: 'epic-1',
    path: worktreePath,
    adopt: true
  })
  expect(worktree.branch).toBe('assigned')
  expect(worktree.owned).toBe(false)
  const tip = await commit(worktree.path, 'child.txt', 'child\n')
  expect(await adapter.integrate(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['rev-parse', 'simmer/epic-1'])).toBe(tip)
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['rev-parse', 'main'])).toBe(tip)
  expect(existsSync(worktree.path)).toBe(true)
  expect(await git(['rev-parse', 'assigned'])).toBe(tip)
})

test('rebases an adopted branch onto the latest run branch before integrating', async () => {
  const worktreePath = join(directory, 'assigned checkout')
  await git(['worktree', 'add', '-b', 'assigned', worktreePath, 'main'])
  const worktree = await adapter.createWorktree({ epic: 'epic-1', path: worktreePath, adopt: true })
  const runWorktree = await worker()
  const previousTip = await commit(runWorktree.path, 'previous.txt', 'previous child\n')
  expect(await adapter.integrate(runWorktree)).toEqual({ kind: 'landed' })
  await adapter.removeWorktree(runWorktree)
  await commit(worktree.path, 'child.txt', 'child\n')
  expect(await adapter.integrate(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['log', '-2', '--format=%s', 'simmer/epic-1'])).toBe('child.txt\nprevious.txt')
  expect(await git(['rev-parse', 'simmer/epic-1^'])).toBe(previousTip)
})

test('refuses to adopt the base checkout or a different repository', async () => {
  await expect(
    adapter.createWorktree({ epic: 'epic-1', path: repository, adopt: true })
  ).rejects.toThrow('Cannot adopt the base branch worktree')
  const otherPath = join(directory, 'other repo')
  mkdirSync(otherPath)
  await git(['init', '-b', 'other'], otherPath)
  await expect(
    adapter.createWorktree({ epic: 'epic-1', path: otherPath, adopt: true })
  ).rejects.toThrow('Worktree belongs to another repo')
})

test('reports ordinary git failures with the exit code', async () => {
  const missingBase = new Git({ cwd: repository, base: 'missing' })
  try {
    await missingBase.createWorktree({ epic: 'epic-1', path: join(directory, 'worker') })
    throw new Error('Expected git failure')
  } catch (error) {
    expect(error).toBeInstanceOf(GitError)
    if (!(error instanceof GitError)) throw error
    expect(error.exitCode).toBe(128)
    expect(error.message).toContain('git branch failed (exit 128)')
  }
})

test('guards the old base ref against a concurrent move before update-ref', async () => {
  const worktree = await worker()
  const runTip = await commit(worktree.path, 'child.txt', 'child\n')
  await git(['switch', '-c', 'other'])
  const binary = Bun.which('git')
  if (!binary) throw new Error('git is required for these tests')
  const binaries = join(directory, 'binaries')
  mkdirSync(binaries)
  writeFileSync(
    join(binaries, 'git'),
    `#!${process.execPath}
const argumentsList = process.argv.slice(2)
async function run(argumentsList, input = '') {
  const child = Bun.spawn([${JSON.stringify(binary)}, ...argumentsList], {
    stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'inherit'
  })
  const [output, exitCode] = await Promise.all([
    new Response(child.stdout).text(), child.exited
  ])
  if (exitCode !== 0) process.exit(exitCode)
  return output.trim()
}
if (argumentsList[4] === 'update-ref' && argumentsList[5] === 'refs/heads/main') {
  const tree = await run(['rev-parse', 'main^{tree}'])
  const oldTip = await run(['rev-parse', 'main'])
  const newTip = await run(['commit-tree', tree, '-p', oldTip], 'concurrent base move\\n')
  await run(['update-ref', 'refs/heads/main', newTip, oldTip])
}
const child = Bun.spawn([${JSON.stringify(binary)}, ...argumentsList], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
})
process.exit(await child.exited)
`,
    { mode: 0o755 }
  )
  process.env.PATH = `${binaries}:${originalPath ?? ''}`
  await expect(integrateAndLand(worktree)).rejects.toThrow('git update-ref failed (exit 128)')
  expect(await git(['log', '-1', '--format=%s', 'main'])).toBe('concurrent base move')
  expect(await git(['rev-parse', 'simmer/epic-1'])).toBe(runTip)
  expect(existsSync(worktree.path)).toBe(true)
})

test('does not stash automatically when git config enables autostash', async () => {
  await git(['config', 'merge.autoStash', 'true'])
  await git(['config', 'rebase.autoStash', 'true'])
  const worktree = await worker()
  await commit(worktree.path, 'child.txt', 'child\n')
  await commit(repository, 'base.txt', 'base moved\n')
  writeFileSync(join(repository, 'local.txt'), 'primary dirty\n')
  expect(await integrateAndLand(worktree)).toEqual({ kind: 'landed' })
  expect(readFileSync(join(repository, 'local.txt'), 'utf8')).toBe('primary dirty\n')
  expect(await git(['for-each-ref', '--format=%(refname)', 'refs/stash'])).toBe('')
})

async function interceptPush(exitCode: number): Promise<void> {
  const binary = Bun.which('git')
  if (!binary) throw new Error('git is required for these tests')
  const binaries = join(directory, 'binaries')
  mkdirSync(binaries)
  const calls = join(directory, 'push.json')
  writeFileSync(
    join(binaries, 'git'),
    `#!${process.execPath}
import { writeFileSync } from 'node:fs'
const argumentsList = process.argv.slice(2)
if (argumentsList[4] === 'push') {
  writeFileSync(${JSON.stringify(calls)}, JSON.stringify(argumentsList.slice(4)))
  process.stderr.write(${JSON.stringify(exitCode === 0 ? '' : 'remote unavailable')})
  process.exit(${exitCode})
}
const child = Bun.spawn([${JSON.stringify(binary)}, ...argumentsList], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
})
process.exit(await child.exited)
`,
    { mode: 0o755 }
  )
  process.env.PATH = `${binaries}:${originalPath ?? ''}`
}

test.each([0, 1])('handles optional push with exit %s after landing', async (exitCode) => {
  const worktree = await worker()
  const tip = await commit(worktree.path, 'child.txt', 'child\n')
  await interceptPush(exitCode)
  expect(await integrateAndLand(worktree, true)).toEqual(
    exitCode === 0
      ? { kind: 'landed' }
      : { kind: 'push-failed', message: 'git push failed (exit 1): remote unavailable' }
  )
  expect(JSON.parse(readFileSync(join(directory, 'push.json'), 'utf8'))).toEqual([
    'push',
    'origin',
    'refs/heads/main'
  ])
  expect(await git(['rev-parse', 'main'])).toBe(tip)
  expect(existsSync(worktree.path)).toBe(exitCode !== 0)
})

test('never attempts push when landing is deferred', async () => {
  const worktree = await worker()
  await commit(worktree.path, 'shared.txt', 'incoming\n')
  writeFileSync(join(repository, 'shared.txt'), 'primary dirty\n')
  await interceptPush(0)
  expect(await integrateAndLand(worktree, true)).toEqual({
    kind: 'deferred',
    files: ['shared.txt']
  })
  expect(existsSync(join(directory, 'push.json'))).toBe(false)
})

test('defers ignored-file overlap and preserves the local secret', async () => {
  await commit(repository, '.gitignore', '.env\n')
  const worktree = await worker()
  writeFileSync(join(worktree.path, '.env'), 'incoming secret\n')
  await git(['add', '-f', '.env'], worktree.path)
  await git(['commit', '-m', 'force-added secret'], worktree.path)
  await adapter.integrate(worktree)
  writeFileSync(join(repository, '.env'), 'local secret\n')
  expect(await adapter.land(worktree)).toEqual({ kind: 'deferred', files: ['.env'] })
  expect(readFileSync(join(repository, '.env'), 'utf8')).toBe('local secret\n')
})

test.each(['merge', 'apply'])(
  'defers a primary mid-rebase with the %s backend',
  async (backend) => {
    await git(['branch', 'upstream'])
    await commit(repository, 'shared.txt', 'main edit\n')
    const mainTip = await git(['rev-parse', 'main'])
    const worktree = await worker()
    await commit(worktree.path, 'child.txt', 'child\n')
    await adapter.integrate(worktree)
    await git(['switch', 'upstream'])
    await commit(repository, 'shared.txt', 'upstream edit\n')
    await git(['switch', 'main'])
    await expect(git(['rebase', `--${backend}`, 'upstream'])).rejects.toThrow()
    const head = await git(['rev-parse', 'HEAD'])
    expect(await adapter.land(worktree)).toEqual({ kind: 'deferred', files: [] })
    expect(await git(['rev-parse', 'main'])).toBe(mainTip)
    expect(await git(['rev-parse', 'HEAD'])).toBe(head)
    expect(readFileSync(join(repository, `.git/rebase-${backend}/head-name`), 'utf8')).toBe(
      'refs/heads/main\n'
    )
  }
)

test('defers a primary mid-merge without ending the merge', async () => {
  await git(['branch', 'other'])
  await commit(repository, 'shared.txt', 'main edit\n')
  const worktree = await worker()
  await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  await git(['switch', 'other'])
  await commit(repository, 'shared.txt', 'other edit\n')
  await git(['switch', 'main'])
  await expect(git(['merge', 'other'])).rejects.toThrow()
  const head = await git(['rev-parse', 'HEAD'])
  expect(await adapter.land(worktree)).toEqual({ kind: 'deferred', files: [] })
  expect(await git(['rev-parse', 'HEAD'])).toBe(head)
  expect(existsSync(join(repository, '.git/MERGE_HEAD'))).toBe(true)
})

test('lands with a detached primary and preserves its checkout', async () => {
  const worktree = await worker()
  const tip = await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  await git(['switch', '--detach'])
  const head = await git(['rev-parse', 'HEAD'])
  writeFileSync(join(repository, 'shared.txt'), 'detached edit\n')
  expect(await adapter.land(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['rev-parse', 'main'])).toBe(tip)
  expect(await git(['rev-parse', 'HEAD'])).toBe(head)
  expect(await git(['branch', '--show-current'])).toBe('')
  expect(readFileSync(join(repository, 'shared.txt'), 'utf8')).toBe('detached edit\n')
})

test('lands an adopted worktree after base moved without switching its branch', async () => {
  const path = join(directory, 'assigned checkout')
  await git(['worktree', 'add', '-b', 'assigned', path, 'main'])
  const worktree = await adapter.createWorktree({ epic: 'epic-1', path, adopt: true })
  const childTip = await commit(path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  const baseTip = await commit(repository, 'base.txt', 'base\n')
  writeFileSync(join(path, 'local.txt'), 'assigned edit\n')
  expect(await adapter.land(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['branch', '--show-current'], path)).toBe('assigned')
  expect(await git(['rev-parse', 'HEAD'], path)).toBe(childTip)
  expect(readFileSync(join(path, 'local.txt'), 'utf8')).toBe('assigned edit\n')
  expect(await git(['rev-parse', 'main^'])).toBe(baseTip)
  expect(await git(['show', 'main:child.txt'])).toBe('child')
  expect((await git(['worktree', 'list', '--porcelain'])).split('worktree ').length).toBe(3)
})

test('aborts a conflicting landing rebase and returns conflict', async () => {
  const worktree = await worker()
  const runTip = await commit(worktree.path, 'shared.txt', 'child edit\n')
  await adapter.integrate(worktree)
  const baseTip = await commit(repository, 'shared.txt', 'base edit\n')
  const result = await adapter.land(worktree)
  expect(result.kind).toBe('conflict')
  expect(await git(['rev-parse', 'simmer/epic-1'])).toBe(runTip)
  expect(await git(['rev-parse', 'main'])).toBe(baseTip)
  expect(await git(['status', '--porcelain=v1'], worktree.path)).toBe('')
  expect((await git(['worktree', 'list', '--porcelain'])).split('worktree ').length).toBe(3)
})

test('aborts a conflicting integration rebase and restores the child checkout', async () => {
  const worktree = await worker()
  const childTip = await commit(worktree.path, 'shared.txt', 'child edit\n')
  const path = join(directory, 'parallel checkout')
  await git(['worktree', 'add', '-b', 'parallel', path, 'main'])
  const runTip = await commit(path, 'shared.txt', 'parallel edit\n')
  await git(['update-ref', 'refs/heads/simmer/epic-1', runTip])
  const result = await adapter.integrate(worktree)
  expect(result.kind).toBe('conflict')
  expect(await git(['rev-parse', 'HEAD'], worktree.path)).toBe(childTip)
  expect(await git(['status', '--porcelain=v1'], worktree.path)).toBe('')
  expect(await git(['branch', '--show-current'], worktree.path)).toBe(worktree.branch)
  expect(await git(['rev-parse', 'simmer/epic-1'])).toBe(runTip)
})

test('merges the checked tip even when the run branch moves before merge', async () => {
  const worktree = await worker()
  const tip = await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  const path = join(directory, 'parallel checkout')
  await git(['worktree', 'add', '-b', 'parallel', path, tip])
  const laterTip = await commit(path, 'local.txt', 'parallel edit\n')
  writeFileSync(join(repository, 'local.txt'), 'local edit\n')
  await interceptGit(`if (argumentsList[4] === 'merge') {
  await run(['update-ref', 'refs/heads/simmer/epic-1', ${JSON.stringify(laterTip)}])
}`)
  expect(await adapter.land(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['rev-parse', 'main'])).toBe(tip)
  expect(await git(['rev-parse', 'simmer/epic-1'])).toBe(laterTip)
  expect(readFileSync(join(repository, 'local.txt'), 'utf8')).toBe('local edit\n')
})

test('verifies HEAD after a merge reports success', async () => {
  const worktree = await worker()
  await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  await interceptGit(`if (argumentsList[4] === 'merge') process.exit(0)`)
  await expect(adapter.land(worktree)).rejects.toThrow('HEAD changed during landing')
})

test('creates a separate child branch after a deferral keeps the first worktree', async () => {
  const first = await worker()
  const tip = await commit(first.path, 'shared.txt', 'incoming\n')
  await adapter.integrate(first)
  writeFileSync(join(repository, 'shared.txt'), 'local edit\n')
  expect(await adapter.land(first)).toEqual({ kind: 'deferred', files: ['shared.txt'] })
  const second = await adapter.createWorktree({ epic: 'epic-1', path: join(directory, 'second') })
  expect(second.start).toBe(tip)
  expect(second.branch).not.toBe(first.branch)
  expect(first.branch).not.toBe(first.runBranch)
  expect(second.branch).not.toBe(second.runBranch)
  await commit(second.path, 'next.txt', 'next\n')
  expect(await adapter.integrate(second)).toEqual({ kind: 'landed' })
  writeFileSync(join(repository, 'shared.txt'), 'original\n')
  expect(await adapter.land(second)).toEqual({ kind: 'landed' })
  expect(await git(['show', 'main:next.txt'])).toBe('next')
})

test('reports cleanup failure while returning landed', async () => {
  const worktree = await worker()
  const tip = await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  writeFileSync(join(worktree.path, 'notes.txt'), 'keep\n')
  expect(await adapter.land(worktree)).toEqual({
    kind: 'landed',
    cleanupError: expect.stringContaining('git worktree failed')
  })
  expect(await git(['rev-parse', 'main'])).toBe(tip)
  expect(readFileSync(join(worktree.path, 'notes.txt'), 'utf8')).toBe('keep\n')
  expect(await git(['rev-parse', worktree.branch])).toBe(tip)
})

test('defers when an ignored file appears between the overlap check and merge', async () => {
  await commit(repository, '.gitignore', '.env\n')
  const worktree = await worker()
  writeFileSync(join(worktree.path, '.env'), 'incoming secret\n')
  await git(['add', '-f', '.env'], worktree.path)
  await git(['commit', '-m', 'force-added secret'], worktree.path)
  await adapter.integrate(worktree)
  await interceptGit(`if (argumentsList[4] === 'merge') {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(${JSON.stringify(join(repository, '.env'))}, 'local secret\\n')
}`)
  expect(await adapter.land(worktree)).toEqual({ kind: 'deferred', files: ['.env'] })
  expect(readFileSync(join(repository, '.env'), 'utf8')).toBe('local secret\n')
})

test('defers a primary bisect of main while HEAD is detached', async () => {
  await commit(repository, 'first.txt', 'first\n')
  await commit(repository, 'second.txt', 'second\n')
  const mainTip = await git(['rev-parse', 'main'])
  const worktree = await worker()
  await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  await git(['bisect', 'start', 'main', 'main~3'])
  const head = await git(['rev-parse', 'HEAD'])
  expect(await git(['branch', '--show-current'])).toBe('')
  expect(await adapter.land(worktree)).toEqual({ kind: 'deferred', files: [] })
  expect(await git(['rev-parse', 'main'])).toBe(mainTip)
  expect(await git(['rev-parse', 'HEAD'])).toBe(head)
  expect(readFileSync(join(repository, '.git/BISECT_START'), 'utf8')).toBe('main\n')
})

test('finds a linked worktree mid-rebase through its own gitdir', async () => {
  await git(['branch', 'upstream'])
  await commit(repository, 'shared.txt', 'main edit\n')
  const mainTip = await git(['rev-parse', 'main'])
  const worktree = await worker()
  await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  await git(['switch', 'upstream'])
  await commit(repository, 'shared.txt', 'upstream edit\n')
  const path = join(directory, 'base checkout')
  await git(['worktree', 'add', path, 'main'])
  await expect(git(['rebase', 'upstream'], path)).rejects.toThrow()
  const head = await git(['rev-parse', 'HEAD'], path)
  expect(await adapter.land(worktree)).toEqual({ kind: 'deferred', files: [] })
  expect(await git(['rev-parse', 'main'])).toBe(mainTip)
  expect(await git(['rev-parse', 'HEAD'], path)).toBe(head)
})

test.each(['integrate', 'land'])('skips a deleted worktree during %s', async (phase) => {
  const worktree = await worker()
  const tip = await commit(worktree.path, 'child.txt', 'child\n')
  if (phase === 'land') expect(await adapter.integrate(worktree)).toEqual({ kind: 'landed' })
  const path = join(directory, 'deleted checkout')
  await git(['worktree', 'add', '--detach', path, 'main'])
  rmSync(path, { recursive: true, force: true })
  expect(await (phase === 'land' ? adapter.land(worktree) : integrateAndLand(worktree))).toEqual({
    kind: 'landed'
  })
  expect(await git(['rev-parse', 'main'])).toBe(tip)
  expect(existsSync(worktree.path)).toBe(false)
})

test('defers when the deleted worktree names the base branch', async () => {
  const baseTip = await git(['rev-parse', 'main'])
  const worktree = await worker()
  const childTip = await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  await git(['switch', '-c', 'other'])
  const path = join(directory, 'deleted base checkout')
  await git(['worktree', 'add', path, 'main'])
  rmSync(path, { recursive: true, force: true })
  expect(await adapter.land(worktree)).toEqual({ kind: 'deferred', files: [] })
  expect(await git(['rev-parse', 'main'])).toBe(baseTip)
  expect(await git(['rev-parse', worktree.branch])).toBe(childTip)
  expect(existsSync(worktree.path)).toBe(true)
})

test('prunes expired missing worktrees before listing', async () => {
  const worktree = await worker()
  await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  const path = join(directory, 'expired checkout')
  await git(['worktree', 'add', '--detach', path, 'main'])
  const gitDirectory = await git(['rev-parse', '--absolute-git-dir'], path)
  rmSync(path, { recursive: true, force: true })
  utimesSync(join(gitDirectory, 'gitdir'), new Date(0), new Date(0))
  utimesSync(gitDirectory, new Date(0), new Date(0))
  utimesSync(join(gitDirectory, 'index'), new Date(0), new Date(0))
  expect(await adapter.land(worktree)).toEqual({ kind: 'landed' })
  expect(await git(['worktree', 'list', '--porcelain'])).toBe(
    `worktree ${repository}\nHEAD ${await git(['rev-parse', 'main'])}\nbranch refs/heads/main`
  )
})

test.each([false, true])(
  'puts rebase worktrees in the common gitdir, linked cwd: %s',
  async (linked) => {
    const worktree = await worker()
    await commit(worktree.path, 'child.txt', 'child\n')
    await adapter.integrate(worktree)
    await commit(repository, 'base.txt', 'base moved\n')
    if (linked) {
      const path = join(directory, 'adapter checkout')
      await git(['worktree', 'add', '--detach', path, 'main'])
      adapter = new Git({ cwd: path, base: 'main' })
    }
    const calls = join(directory, 'temporary-worktree.txt')
    await interceptGit(`if (argumentsList[4] === 'worktree' && argumentsList[6] === '--detach') {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(${JSON.stringify(calls)}, argumentsList[8])
}`)
    expect(await adapter.land(worktree)).toEqual({ kind: 'landed' })
    const path = readFileSync(calls, 'utf8')
    expect(dirname(path)).toBe(join(repository, '.git', 'simmer-tmp'))
    expect(existsSync(path)).toBe(false)
    expect(await git(['branch', '--list', worktree.branch])).toBe('')
  }
)

test('deletes the child branch safely after removing its worktree', async () => {
  const worktree = await worker()
  await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  const calls = join(directory, 'branch-delete.json')
  await interceptGit(`if (argumentsList[4] === 'branch' && argumentsList[5] === '-d') {
  const { existsSync, writeFileSync } = await import('node:fs')
  writeFileSync(${JSON.stringify(calls)}, JSON.stringify({
    argumentsList: argumentsList.slice(4),
    worktreeExists: existsSync(${JSON.stringify(worktree.path)})
  }))
}`)
  expect(await adapter.land(worktree)).toEqual({ kind: 'landed' })
  expect(JSON.parse(readFileSync(calls, 'utf8'))).toEqual({
    argumentsList: ['branch', '-d', '--', worktree.branch],
    worktreeExists: false
  })
  expect(await git(['branch', '--list', worktree.branch])).toBe('')
})

test('keeps unmerged child commits when safe branch deletion refuses', async () => {
  const worktree = await worker()
  const landedTip = await commit(worktree.path, 'child.txt', 'child\n')
  await adapter.integrate(worktree)
  const unmergedTip = await commit(worktree.path, 'extra.txt', 'keep\n')
  expect(await adapter.land(worktree)).toEqual({
    kind: 'landed',
    cleanupError: expect.stringContaining('git branch failed')
  })
  expect(await git(['rev-parse', 'main'])).toBe(landedTip)
  expect(await git(['rev-parse', worktree.branch])).toBe(unmergedTip)
  expect(await git(['show', `${worktree.branch}:extra.txt`])).toBe('keep')
})

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { runHarness } from '../src/harness'
import { rolePrompt } from '../src/harness/process'

const fixture = readFileSync(new URL('./fixtures/opencode.jsonl', import.meta.url), 'utf8')
const errorFixture = readFileSync(
  new URL('./fixtures/opencode-error.jsonl', import.meta.url),
  'utf8'
)
const prompt = 'Do the task. Keep "quotes" and $variables literal.\nSecond line.'
let directory: string

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer-opencode-')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

async function run(output: string, exitCode = 0) {
  const binary = join(directory, 'opencode')
  writeFileSync(
    binary,
    `#!${process.execPath}
await Bun.write('invocation.json', JSON.stringify({
  arguments: process.argv.slice(2), cwd: process.cwd(), stdin: await Bun.stdin.text(),
  permission: process.env.OPENCODE_PERMISSION, marker: process.env.OPENCODE_TEST_MARKER
}))
process.stdout.write(${JSON.stringify(output)})
process.exitCode = ${exitCode}
`,
    { mode: 0o755 }
  )
  writeFileSync(
    join(directory, 'simmer.json'),
    JSON.stringify({ harness: 'opencode', harnessPaths: { opencode: binary } })
  )
  const config = await loadConfig(directory)
  return runHarness({
    prompt,
    cwd: directory,
    config,
    env: { OPENCODE_PERMISSION: '{"*":"deny"}', OPENCODE_TEST_MARKER: 'preserved' }
  })
}

test('OpenCode uses headless flags, writable agent, role prompt, and per-run permissions', async () => {
  const result = await run(fixture)
  expect(JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8'))).toEqual({
    arguments: [
      'run',
      '--format',
      'json',
      '--auto',
      '--agent',
      'build',
      rolePrompt(prompt, { reviewer: 'claude:opus' })
    ],
    cwd: directory,
    stdin: '',
    permission: '{"*":"allow"}',
    marker: 'preserved'
  })
  expect(result).toEqual({
    exitCode: 0,
    finalMessage: 'probe complete',
    usage: {
      inputTokens: 21943,
      outputTokens: 256,
      cacheReadTokens: 49024,
      cacheWriteTokens: 0
    },
    killedByWatchdog: false
  })
})

test('OpenCode keeps only the last message, joins text parts, and replaces repeated parts', async () => {
  const text = (messageID: string, id: string, value: string) =>
    JSON.stringify({ type: 'text', part: { messageID, id, text: value } })
  const output = [
    text('earlier', 'first', 'Earlier message'),
    text('last', 'second', 'Part'),
    text('last', 'second', 'Complete'),
    text('last', 'third', ' answer'),
    '{"type":"tool_use","part":{"text":"Tool output"}}'
  ].join('\n')
  expect((await run(output)).finalMessage).toBe('Complete answer')
})

test('OpenCode deduplicates step usage by part id', async () => {
  expect((await run(fixture + fixture)).usage).toEqual((await run(fixture)).usage)
})

test('OpenCode preserves text and usage when the process fails after work', async () => {
  const result = await run(fixture + errorFixture, 9)
  expect(result.exitCode).toBe(9)
  expect(result.finalMessage).toBe('probe complete')
  expect(result.usage?.outputTokens).toBe(256)
})

test('OpenCode returns the captured error exit without inventing text or usage', async () => {
  expect(await run(errorFixture, 1)).toEqual({
    exitCode: 1,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: false
  })
})

test.each([
  { input: '42', output: 1 },
  { input: 1, output: -1 },
  { input: 1, output: 1, reasoning: '2' },
  { input: 1, output: 1, reasoning: -2 },
  { input: 1, output: 1, cache: { read: '9' } },
  {}
])('OpenCode leaves invalid usage undefined: %j', async (tokens) => {
  const output = JSON.stringify({ type: 'step_finish', part: { tokens } })
  expect((await run(output)).usage).toBeUndefined()
})

test('OpenCode preserves reported zero usage and cache writes', async () => {
  const output = JSON.stringify({
    type: 'step_finish',
    part: { tokens: { input: 0, output: 0, cache: { read: 0, write: 12 } } }
  })
  expect((await run(output)).usage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 12
  })
})

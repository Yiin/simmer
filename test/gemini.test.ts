import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { runHarness } from '../src/harness'
import { rolePrompt } from '../src/harness/process'

const fixture = readFileSync(new URL('./fixtures/gemini-stream.jsonl', import.meta.url), 'utf8')
const prompt = 'Do the task. Keep "quotes" and $variables literal.\nSecond line.'
let directory: string

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer-gemini-test-')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

async function run(stream: string, exitCode = 0) {
  const binary = join(directory, 'custom gemini')
  writeFileSync(
    binary,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs'
writeFileSync('invocation.json', JSON.stringify({
  arguments: process.argv.slice(2), cwd: process.cwd(), stdin: await Bun.stdin.text(),
  auth: process.env.GEMINI_API_KEY
}))
process.stdout.write(${JSON.stringify(stream)})
process.exit(${exitCode})
`,
    { mode: 0o755 }
  )
  writeFileSync(join(directory, 'simmer.json'), JSON.stringify({ harness: 'gemini' }))
  const config = await loadConfig(directory)
  return runHarness({
    prompt,
    cwd: directory,
    config: { ...config, harnessPaths: { ...config.harnessPaths, gemini: binary } },
    env: { GEMINI_API_KEY: 'test-placeholder' }
  })
}

test('Gemini uses unattended flags and parses the live stream fixture', async () => {
  expect(await run(fixture)).toEqual({
    exitCode: 0,
    finalMessage: 'Probe complete.',
    usage: { inputTokens: 32820, outputTokens: 219, cacheReadTokens: 32602, cacheWriteTokens: 0 },
    killedByWatchdog: false
  })
  expect(JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8'))).toEqual({
    arguments: [
      '-p',
      rolePrompt(prompt, { reviewer: 'claude:opus' }),
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--sandbox=false',
      '--skip-trust'
    ],
    cwd: directory,
    stdin: '',
    auth: 'test-placeholder'
  })
})

test('Gemini joins final chunks after tool calls and ignores other roles', async () => {
  const extra = [
    { type: 'tool_use', tool_name: 'read_file' },
    { type: 'message', role: 'assistant', content: 'Final ', delta: true },
    { type: 'message', role: 'user', content: 'Ignore user' },
    { type: 'tool_result', output: 'Ignore tool' },
    { type: 'message', role: 'assistant', content: 'answer.', delta: true }
  ]
  const stream = fixture + extra.map((event) => JSON.stringify(event)).join('\n')
  expect((await run(stream)).finalMessage).toBe('Final answer.')
})

test('Gemini replaces non-delta messages and leaves missing usage undefined', async () => {
  const stream = [
    { type: 'message', role: 'assistant', content: 'Earlier', delta: true },
    { type: 'message', role: 'assistant', content: 'Complete answer' },
    { type: 'result', status: 'success' }
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')
  const result = await run(stream)
  expect(result.finalMessage).toBe('Complete answer')
  expect(result.usage).toBeUndefined()
})

test('Gemini preserves a failure exit and rejects invalid token counts', async () => {
  const stream = [
    { type: 'error', message: 'API request failed' },
    { type: 'result', status: 'error', stats: { input_tokens: 4, output_tokens: 1, cached: 9 } }
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')
  expect(await run(stream, 1)).toEqual({
    exitCode: 1,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: false
  })
})

test('Gemini replaces aggregate usage rather than counting it twice', async () => {
  const stream = `${fixture}${fixture}`
  expect((await run(stream)).usage).toEqual({
    inputTokens: 32820,
    outputTokens: 219,
    cacheReadTokens: 32602,
    cacheWriteTokens: 0
  })
})

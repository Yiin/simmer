import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { runHarness } from '../src/harness'
import { run } from '../src/harness/crush'
import { type RunOptions, rolePrompt } from '../src/harness/process'

const fixture = readFileSync(new URL('./fixtures/crush.txt', import.meta.url), 'utf8')
let directory: string
let options: RunOptions

beforeEach(() => {
  directory = mkdtempSync('/tmp/simmer-crush-test-')
  options = {
    binary: join(directory, 'custom crush'),
    cwd: directory,
    prompt: 'Keep "quotes", $variables, and\nnewlines literal.',
    models: { reviewer: 'claude:opus' },
    watchdogMinutes: 1,
    watchdogIntervalMs: 20,
    env: { CRUSH_CLIENT_SERVER: '1', CRUSH_TEST_ENV: 'preserved' }
  }
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function fake(body: string) {
  writeFileSync(
    options.binary,
    `#!${process.execPath}
await Bun.write('invocation.json', JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), stdin: await Bun.stdin.text(),
  embedded: process.env.CRUSH_CLIENT_SERVER, inherited: process.env.CRUSH_TEST_ENV
}))
${body}
`,
    { mode: 0o755 }
  )
}

test('Crush returns the live text fixture and runs embedded with role instructions', async () => {
  fake(`process.stdout.write(${JSON.stringify(fixture)})`)
  expect(await run(options)).toEqual({
    exitCode: 0,
    finalMessage: fixture.trim(),
    usage: undefined,
    killedByWatchdog: false
  })
  expect(JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8'))).toEqual({
    args: ['run', '--quiet', '--cwd', directory, rolePrompt(options.prompt, options.models)],
    cwd: directory,
    stdin: '',
    embedded: '0',
    inherited: 'preserved'
  })
})

test('Crush config selects the adapter, custom binary, and default reviewer', async () => {
  writeFileSync(
    join(directory, 'simmer.json'),
    JSON.stringify({ harness: 'crush', harnessPaths: { crush: options.binary } })
  )
  fake(`process.stdout.write(${JSON.stringify(fixture)})`)
  const config = await loadConfig(directory)
  expect(config.models.crush).toEqual({ reviewer: 'claude:opus' })
  expect((await runHarness({ ...options, config })).finalMessage).toBe(fixture.trim())
})

test('Crush preserves multiline text, JSON-looking text, and fragmented UTF-8', async () => {
  const text = `${fixture.trim()}\n{"usage":{"input_tokens":999}}\nFinal ☕`
  fake(`
const bytes = Buffer.from(${JSON.stringify(text)})
const split = bytes.indexOf(Buffer.from('☕')) + 1
process.stdout.write(bytes.subarray(0, split))
setTimeout(() => process.stdout.write(bytes.subarray(split)), 30)
`)
  const result = await run(options)
  expect(result.finalMessage).toBe(text)
  expect(result.usage).toBeUndefined()
})

test.each([false, true])(
  'Crush keeps exit status and text after failure (text=%s)',
  async (text) => {
    fake(`
process.stderr.write('No providers configured\\n')
${text ? `process.stdout.write(${JSON.stringify(fixture)})` : ''}
process.exitCode = 9
`)
    expect(await run(options)).toEqual({
      exitCode: 9,
      finalMessage: text ? fixture.trim() : '',
      usage: undefined,
      killedByWatchdog: false
    })
  }
)

test('Crush shares the watchdog for silent workers', async () => {
  fake('setInterval(() => {}, 1000)')
  expect(await run({ ...options, watchdogMinutes: 0.005 })).toEqual({
    exitCode: 137,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: true
  })
})

test('Crush text activity keeps the watchdog alive', async () => {
  fake(`
const timer = setInterval(() => process.stdout.write('Still working. '), 50)
setTimeout(() => clearInterval(timer), 700)
`)
  const result = await run({ ...options, watchdogMinutes: 0.005 })
  expect(result.exitCode).toBe(0)
  expect(result.finalMessage).toContain('Still working.')
  expect(result.killedByWatchdog).toBe(false)
})

test('Crush rejects a missing binary', async () => {
  await expect(run(options)).rejects.toThrow('ENOENT')
})

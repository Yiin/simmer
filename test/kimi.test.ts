import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { runHarness } from '../src/harness'
import { rolePrompt } from '../src/harness/process'

const fixture = await readFile(new URL('./fixtures/kimi-stream.jsonl', import.meta.url), 'utf8')
const finalMessage =
  'Created `hello.txt` with exactly `kimi probe ok` plus a trailing newline. `od -c` confirms 14 bytes ending in `\\n`.\n\nkimi probe done'
const prompt = 'Keep "quotes", $variables, and `commands` literal.\nSecond line.'

async function execute(output: string, exitCode = 0, override = false) {
  const directory = await mkdtemp('/tmp/simmer-kimi-test-')
  try {
    const binary = join(directory, 'custom-kimi')
    await writeFile(
      binary,
      `#!${process.execPath}
await Bun.write('invocation.json', JSON.stringify({
  arguments: process.argv.slice(2), cwd: process.cwd(), stdin: await Bun.stdin.text()
}))
process.stdout.write(${JSON.stringify(output)})
process.exitCode = ${exitCode}
`,
      { mode: 0o755 }
    )
    await writeFile(
      join(directory, 'simmer.json'),
      JSON.stringify({
        harness: override ? 'claude' : 'kimi',
        harnessPaths: { kimi: binary },
        models: { kimi: { planner: 'custom-plan' } }
      })
    )
    const config = await loadConfig(directory)
    const result = await runHarness({
      prompt,
      cwd: directory,
      config: override ? { ...config, harness: 'kimi' } : config
    })
    const invocation: unknown = JSON.parse(
      await readFile(join(directory, 'invocation.json'), 'utf8')
    )
    return { result, invocation, directory }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test.each([false, true])(
  'Kimi reads the live fixture with harness override=%s',
  async (override) => {
    const { result, invocation, directory } = await execute(fixture, 0, override)
    expect(result).toEqual({
      exitCode: 0,
      finalMessage,
      usage: undefined,
      killedByWatchdog: false
    })
    expect(invocation).toEqual({
      arguments: [
        '-p',
        rolePrompt(prompt, { planner: 'custom-plan', reviewer: 'claude:opus' }),
        '--output-format',
        'stream-json'
      ],
      cwd: directory,
      stdin: ''
    })
  }
)

test('Kimi preserves the final assistant message on a failed exit', async () => {
  const { result } = await execute(fixture, 9)
  expect(result).toEqual({
    exitCode: 9,
    finalMessage,
    usage: undefined,
    killedByWatchdog: false
  })
})

test('Kimi returns failure without text or usage when authentication fails', async () => {
  const { result } = await execute('{"role":"meta","type":"system.version","version":"2.0.0"}\n', 1)
  expect(result).toEqual({
    exitCode: 1,
    finalMessage: '',
    usage: undefined,
    killedByWatchdog: false
  })
})

test('Kimi ignores tool and resume messages after an unterminated assistant line', async () => {
  const { result } = await execute(
    `${fixture}{"role":"tool","content":"Tool output"}\n` +
      '{"role":"meta","type":"session.resume_hint","content":"Resume command"}\n' +
      '{"role":"assistant","tool_calls":[]}\n' +
      '{"role":"assistant","content":"Final ☕"}'
  )
  expect(result.finalMessage).toBe('Final ☕')
  expect(result.usage).toBeUndefined()
})

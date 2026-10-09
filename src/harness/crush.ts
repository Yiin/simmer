import { flag, type RunOptions, runProcess, workerPrompt } from './process'

export function run(options: RunOptions) {
  return runProcess(
    [
      options.binary,
      'run',
      '--quiet',
      '--cwd',
      options.cwd,
      ...flag('--model', options.model),
      ...flag('--reasoning-effort', options.effort),
      workerPrompt(options)
    ],
    {
      ...options,
      // Embedded non-interactive sessions auto-approve file and shell permissions.
      env: { ...options.env, CRUSH_CLIENT_SERVER: '0' }
    },
    'text'
  )
}

import { type RunOptions, rolePrompt, runProcess } from './process'

export function run(options: RunOptions) {
  return runProcess(
    [
      options.binary,
      'run',
      '--quiet',
      '--cwd',
      options.cwd,
      rolePrompt(options.prompt, options.models)
    ],
    {
      ...options,
      // Embedded non-interactive sessions auto-approve file and shell permissions.
      env: { ...options.env, CRUSH_CLIENT_SERVER: '0' }
    },
    'text'
  )
}

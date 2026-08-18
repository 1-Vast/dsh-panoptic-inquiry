export const name = 'custom-bash'
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 300000
const DEFAULT_MAX_OUTPUT_BYTES = 64000

const commandSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The bash command to execute (`bash -c` string domain).' },
    workdir: { type: 'string', description: 'Optional working directory; defaults to the session cwd.' },
  },
  required: ['command'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  const bashPath = typeof config?.bashPath === 'string' && config.bashPath.length > 0 ? config.bashPath : 'bash'
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(config?.maxOutputBytes) && config.maxOutputBytes > 0 ? config.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in a bash shell (Git Bash on Windows)',
      '* Commands run in a fresh process; state does not persist between calls.',
      '* This tool runs without OS sandbox confinement on Windows; do not use it for network access.',
      '* Avoid commands that may produce a very large amount of output.',
      '* This tool is for work that finishes inside one tool call. Backgrounding with `&` does NOT return control here: the child inherits this call\'s output pipes and holds it open until the child exits, and the timeout then kills the launcher without stopping the work. Use bash_job for anything expected to exceed ~90 seconds.',
    ].join('\n'),
    parameters: commandSchema,
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string' } }, required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs,
    async execute(args, exec) {
      const shell = await ctx.subprocess.resolveExecutable(bashPath, undefined, exec?.signal)
      const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
        ? args.workdir
        : exec?.agent?.session?.header?.cwd
      const handle = ctx.subprocess.spawn({
        argv: [shell, '-c', args.command],
        ...(workdir !== undefined ? { cwd: workdir } : {}),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
        graceMs: 3000,
      })
      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        throw new Error(`bash spawn failed: ${String(error)}`)
      }
      let stdout = ''
      let stderr = ''
      try {
        stdout = handle.collected.stdout.readFrom(0).text
        stderr = handle.collected.stderr.readFrom(0).text
      } catch {
        // Some subprocess backends may not expose collected readers.
      }
      const text = [stdout, stderr].filter(part => part.length > 0).join('\n')
      if (outcome.exitCode !== 0) {
        // Keep the exit code even when the command printed something: `1` from
        // grep, `5` from an empty pytest run and a crash are different facts,
        // and a failure message alone cannot distinguish them.
        const code = Number.isInteger(outcome.exitCode) ? outcome.exitCode : 'unknown (terminated)'
        throw new Error(text.length > 0 ? `${text}\n(exit code: ${code})` : `exit code: ${code}`)
      }
      return { text: text || 'exit code: 0 (no output)' }
    },
  })
}

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

/**
 * No-progress detector.
 *
 * A repair loop looks identical from the outside: the same command returns the
 * same failure with the same output. The model cannot see that it is repeating
 * itself without spending a reasoning turn to notice, so the runtime says it
 * in-band, at the exact point where the next decision is made. Only failures
 * are tracked — repeating a successful command is normal.
 */
const repeatsBySession = new WeakMap()
const MAX_TRACKED_SIGNATURES = 64

export function noteRepeat(session, signature) {
  if (session === undefined) return 1
  let seen = repeatsBySession.get(session)
  if (seen === undefined) {
    seen = new Map()
    repeatsBySession.set(session, seen)
  }
  const count = (seen.get(signature) ?? 0) + 1
  seen.delete(signature)
  seen.set(signature, count)
  // Bounded: drop the least recently touched signature.
  if (seen.size > MAX_TRACKED_SIGNATURES) seen.delete(seen.keys().next().value)
  return count
}

/** Advisory appended to a repeated identical failure. */
export function repeatNotice(count) {
  if (count < 2) return ''
  return `\n\n[no progress: identical failure ${count}x — same command, same exit code, same output.`
    + ' Retrying or making another small variation of this approach will not change the result.'
    + ' Change the strategy: different command shape, different mutation path, or fix the'
    + ' environment/state this depends on.]'
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
      '* A non-zero exit is returned as a normal result whose first line is `exit code: N`, not as a tool error — read it and decide what it means (grep 1 = no match, diff 1 = differs, pytest 5 = nothing collected, 127 = command not found). Only a spawn failure, a timeout kill, or a cancellation raises an error.',
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
      const code = outcome?.exitCode

      // No exit code means the process never reported one: a timeout kill, a
      // cancellation, or a lifecycle failure. That is an execution failure, so
      // it stays an exception.
      if (!Number.isInteger(code)) {
        const reason = exec?.signal?.aborted === true ? 'cancelled' : 'terminated without an exit code (timeout or external kill)'
        throw new Error(text.length > 0 ? `${text}\n(${reason})` : reason)
      }

      if (code === 0) return { text: text || 'exit code: 0 (no output)' }

      const session = exec?.agent?.session
      const signature = `${args.command}\u0000${code}\u0000${text.split('\n', 1)[0]}`
      const notice = repeatNotice(noteRepeat(session, signature))

      // A non-zero exit is a COMMAND-DOMAIN RESULT, not an infrastructure
      // failure: grep 1 means no match, diff 1 means files differ, pytest 5
      // means nothing was collected. Throwing here forced the caller to
      // re-plan around an exception instead of reading the outcome, so the
      // code is reported in the result and the caller decides what it means.
      return { text: `exit code: ${code}\n${text || '(no output)'}${notice}` }
    },
  })
}

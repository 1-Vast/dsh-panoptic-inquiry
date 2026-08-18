import { classifyProcess, trackFailure, clearFailure, failureSignature, FAILURE_CLASS } from './failure-signature.mjs'

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
      '* A non-zero exit is returned as a normal result whose first line is `exit code: N`, not as a tool error — read it and decide what it means (grep 1 = no match, diff 1 = differs, pytest 5 = nothing collected, 127 = command not found). Only a spawn failure, a timeout kill, or a cancellation raises an error.',
      '* This tool is for work that finishes inside one tool call. Backgrounding with `&` does NOT return control here: the child inherits this call\'s output pipes and holds it open until the child exits, and the timeout then kills the launcher without stopping the work. Use bash_job for anything expected to exceed ~90 seconds.',
    ].join('\n'),
    parameters: commandSchema,
    output: {
      // `text` is unchanged from before, so existing callers and the rendered
      // transcript are untouched. The scalars beside it let generated Code Mode
      // branch on the outcome without parsing the string — and they are scalars
      // on purpose: repeating stdout/stderr as separate fields would duplicate
      // the whole output in context for no decision value.
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string' },
          exitCode: { type: 'number' },
          ok: { type: 'boolean' },
          failureClass: { type: 'string' },
        },
        required: ['text', 'exitCode', 'ok'],
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

      const session = exec?.agent?.session
      const cancelled = exec?.signal?.aborted === true

      // No exit code means the process never reported one: a timeout kill, a
      // cancellation, or a lifecycle failure. That is an execution failure, so
      // it stays an exception.
      if (!Number.isInteger(code)) {
        const head = text.length > 0 ? `${text}\n` : ''
        if (cancelled) throw new Error(`${head}(cancelled)`)
        // A killed process is a lifecycle failure; repeating it is the loop
        // that bash_job exists to end.
        const killed = trackFailure(session, { failureClass: FAILURE_CLASS.processLifecycle, target: args.command })
        throw new Error(`${head}(terminated without an exit code (timeout or external kill))${killed.notice}`)
      }

      if (code === 0) {
        // Success retires the failure families this command accumulated, so a
        // later unrelated failure starts its own count.
        for (const failureClass of Object.values(FAILURE_CLASS)) {
          clearFailure(session, failureSignature({ failureClass, target: args.command }))
        }
        return { text: text || 'exit code: 0 (no output)', exitCode: 0, ok: true }
      }

      const failureClass = classifyProcess({ exitCode: code, cancelled, output: text })
      const { notice } = trackFailure(session, { failureClass, target: args.command })

      // A non-zero exit is a COMMAND-DOMAIN RESULT, not an infrastructure
      // failure: grep 1 means no match, diff 1 means files differ, pytest 5
      // means nothing was collected. Throwing here forced the caller to
      // re-plan around an exception instead of reading the outcome, so the
      // code is reported in the result and the caller decides what it means.
      return {
        text: `exit code: ${code}\n${text || '(no output)'}${notice}`,
        exitCode: code,
        ok: false,
        failureClass,
      }
    },
  })
}

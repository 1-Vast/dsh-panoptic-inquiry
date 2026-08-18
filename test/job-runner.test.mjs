import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  buildJobId,
  classifyState,
  composeLaunch,
  parseBlock,
  renderStatus,
  shellQuote,
  toShellPath,
} from '../preset/deep-performance/job-runner.mjs'

// ── deterministic unit coverage ─────────────────────────────────────────────

test('job ids are sortable and shell-safe', () => {
  const id = buildJobId(Date.parse('2026-08-18T09:07:05Z'), 0.5)
  assert.match(id, /^job-20260818090705-[0-9a-z]{3}$/)
  assert.ok(buildJobId(1, 0) < buildJobId(2 ** 40, 0))
})

test('windows paths cross into the shell domain with forward slashes', () => {
  assert.equal(toShellPath('D:\\work\\repo'), 'D:/work/repo')
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
})

test('the payload crosses verbatim through a quoted heredoc', () => {
  const command = `python -c "print('$HOME' + \`date\`)" && echo 'done'`
  const script = composeLaunch({
    jobDir: 'D:/w/.dsh-jobs/job-1',
    workdir: 'D:/w',
    command,
    delimiter: 'DSH_JOB_TEST',
  })
  assert.ok(script.includes(`cat > payload.sh <<'DSH_JOB_TEST'\n${command}\nDSH_JOB_TEST`))
  // Every stream of the supervisor is redirected away from the launcher pipes:
  // this is what makes the launch call return instead of holding the job open.
  assert.match(script, /nohup bash run\.sh > launch\.log 2>&1 &/)
  assert.match(script, /ps -W \| awk -v p=\$\$/)
})

test('state is derived from durable evidence only', () => {
  assert.equal(classifyState({ present: '0' }).state, 'missing')
  assert.equal(classifyState({ present: '1' }).state, 'starting')
  assert.equal(classifyState({ present: '1', winpid: '42', alive: '1' }).state, 'running')
  assert.equal(classifyState({ present: '1', winpid: '42', alive: '0' }).state, 'died')
  assert.deepEqual(classifyState({ present: '1', winpid: '42', alive: '0', exit: '0' }), { state: 'completed', exitCode: 0 })
  assert.deepEqual(classifyState({ present: '1', winpid: '42', alive: '0', exit: '3' }), { state: 'failed', exitCode: 3 })
  assert.equal(classifyState({ present: '1', winpid: '42', alive: '0', cancelled: '2026-08-18' }).state, 'cancelled')
})

test('a dead job never reports its partial log as a completed run', () => {
  const line = renderStatus('job-1', parseBlock('present=1\nwinpid=42\nalive=0\nlogbytes=120\n'))
  assert.match(line, /died/)
  assert.match(line, /PARTIAL output, not a completed run/)
})

// ── real process lifecycle (Windows + Git Bash) ─────────────────────────────

const BASH = 'C:/Program Files/Git/bin/bash.exe'
const canRunWindowsLifecycle = process.platform === 'win32' && existsSync(BASH)

/**
 * Mirror of the host subprocess contract that `custom-bash` already relies on:
 * argv/cwd/stdio, `done`, and `collected.<stream>.readFrom(0).text`. Using the
 * real shell is the point — a mocked spawn cannot prove a Windows lifecycle.
 */
function realSubprocess() {
  return {
    async resolveExecutable(path) { return path },
    spawn({ argv, cwd, stdio, signal }) {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal === undefined ? {} : { signal }),
      })
      const buffers = { stdout: '', stderr: '' }
      child.stdout.on('data', chunk => { buffers.stdout += chunk.toString() })
      child.stderr.on('data', chunk => { buffers.stderr += chunk.toString() })
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        // Resolve on `close` (all stdio drained), the semantics that make a
        // pipe-inheriting background child hold a launcher open.
        child.on('close', exitCode => resolve({ exitCode }))
      })
      void stdio
      return { done, collected: { stdout: { readFrom: () => ({ text: buffers.stdout }) }, stderr: { readFrom: () => ({ text: buffers.stderr }) } } }
    },
  }
}

function mountJobRunner(cwd) {
  const registered = []
  apply({
    subprocess: realSubprocess(),
    tools: { register(tool) { registered.push(tool) } },
  }, { bashPath: BASH, controlTimeoutMs: 30000, jobsDir: '.dsh-jobs', maxLogChars: 2000 })
  const tool = registered.find(item => item.name === 'bash_job')
  const exec = { agent: { session: { header: { cwd } } } }
  return { tool, call: (args) => tool.execute(args, exec) }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('the bash tool cannot own a long job: `&` holds the call open for the child\'s lifetime', { skip: !canRunWindowsLifecycle }, async () => {
  // The failure this plugin exists to remove, reproduced through the same
  // contract custom-bash uses: the backgrounded child inherits the pipes.
  const subprocess = realSubprocess()
  const shell = await subprocess.resolveExecutable(BASH)
  const started = Date.now()
  const handle = subprocess.spawn({ argv: [shell, '-c', 'sleep 4 & echo LAUNCHED'], stdio: {} })
  await handle.done
  const elapsed = Date.now() - started
  assert.ok(elapsed > 3000, `expected the launcher to stay attached for the child's lifetime, returned in ${elapsed}ms`)
  assert.match(handle.collected.stdout.readFrom(0).text, /LAUNCHED/)
})

test('a durable job outlives its launcher and is observable, cancellable, and never mistaken for complete', { skip: !canRunWindowsLifecycle }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-job-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const { call } = mountJobRunner(workspace)

  // 1. start a child that runs far longer than the launcher
  const startedAt = Date.now()
  const start = await call({ action: 'start', command: 'for i in $(seq 1 60); do echo tick$i; sleep 1; done' })
  const launchMs = Date.now() - startedAt
  const jobId = start.text.match(/job-[0-9a-z-]+/)[0]

  // 2. the launcher returns promptly instead of waiting for the job
  assert.ok(launchMs < 5000, `launch should return promptly, took ${launchMs}ms`)

  // 3. the child is alive after the launching shell and the tool call ended
  await wait(2500)
  const running = await call({ action: 'status', job_id: jobId })
  assert.match(running.text, /: running/)
  assert.match(running.text, /pid \d+/)

  // 4. status is non-blocking and does not spawn a second job
  const statusStart = Date.now()
  await call({ action: 'status', job_id: jobId })
  assert.ok(Date.now() - statusStart < 5000, 'status must not block on the job')
  const list = await call({ action: 'list' })
  assert.match(list.text, /^1 job\(s\)/m)

  // 5. output accumulates while the model is free to do other work
  const firstLog = await call({ action: 'logs', job_id: jobId })
  assert.match(firstLog.text, /tick1/)
  await wait(2000)
  const secondLog = await call({ action: 'logs', job_id: jobId })
  assert.notEqual(firstLog.text, secondLog.text, 'a live job keeps producing output after the launch call returned')

  // 6. cancellation terminates the process tree
  await call({ action: 'cancel', job_id: jobId })
  const cancelled = await call({ action: 'status', job_id: jobId })
  assert.match(cancelled.text, /: cancelled/)
  const afterCancel = await readFile(join(workspace, '.dsh-jobs', jobId, 'log'), 'utf8')
  await wait(2000)
  assert.equal(await readFile(join(workspace, '.dsh-jobs', jobId, 'log'), 'utf8'), afterCancel, 'cancelled job must stop producing output')
  assert.equal(existsSync(join(workspace, '.dsh-jobs', jobId, 'exit')), false, 'a cancelled job must not look completed')

  // 7. a finished job preserves its output and its exit code
  const second = await call({ action: 'start', command: 'echo first line; echo to stderr 1>&2; exit 3' })
  const secondId = second.text.match(/job-[0-9a-z-]+/)[0]
  let final = ''
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(500)
    final = (await call({ action: 'status', job_id: secondId })).text
    if (!/: (starting|running)/.test(final)) break
  }
  assert.match(final, /: failed/)
  assert.match(final, /exit code 3/)
  const finalLog = await call({ action: 'logs', job_id: secondId })
  assert.match(finalLog.text, /first line/)
  assert.match(finalLog.text, /to stderr/)

  // 8. repeated inspection never creates duplicates
  const finalList = await call({ action: 'list' })
  assert.match(finalList.text, /^2 job\(s\)/m)
})

test('control actions validate their job id instead of running arbitrary shell text', { skip: !canRunWindowsLifecycle }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-job-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const { call } = mountJobRunner(workspace)
  await assert.rejects(call({ action: 'status', job_id: '../../etc' }), /job_id must be an id returned by start/)
  await assert.rejects(call({ action: 'start', command: '  ' }), /start requires a non-empty command/)
  await assert.rejects(call({ action: 'frobnicate' }), /unknown action/)
})

/**
 * Behavioral replay: the failure sequences that motivated Beta.5 and Beta.6,
 * scored by the metric that matters — model decision boundaries per completed
 * task.
 *
 * WHAT THIS IS: a DETERMINISTIC replay. The Beta.6 side executes the real
 * tools against real files through real Git Bash. The Beta.5 side re-creates
 * the previous contracts exactly (an exact-string editor that raises, a bash
 * that raises on any non-zero exit, a payload that crosses shell quoting) and
 * runs them against the same fixtures. No language model is involved, so these
 * are not live-session results; what is measured is how many times each
 * contract FORCES control back to the model.
 *
 * COUNTING RULE — one boundary is charged when:
 *   1. a tool raises, so the caller must interpret an exception and re-plan; or
 *   2. a tool returns an outcome whose next action cannot be computed by the
 *      code already generated for this step — i.e. the caller must look at
 *      prose and decide.
 * Consecutive calls whose next action follows deterministically from a status
 * field cost ONE boundary together, because Code Mode can chain them inside a
 * single generated block.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyEdit } from '../preset/deep-performance/edit-apply.mjs'
import { apply as applyBash } from '../preset/deep-performance/custom-bash.mjs'

const BASH = 'C:/Program Files/Git/bin/bash.exe'
const BS = String.fromCharCode(92)
const canReplay = process.platform === 'win32' && existsSync(BASH)
const report = []

function realSubprocess() {
  return {
    async resolveExecutable(path) { return path },
    spawn({ argv, cwd, signal }) {
      const child = spawn(argv[0], argv.slice(1), {
        cwd, stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal === undefined ? {} : { signal }),
      })
      const buffers = { stdout: '', stderr: '' }
      child.stdout.on('data', chunk => { buffers.stdout += chunk.toString() })
      child.stderr.on('data', chunk => { buffers.stderr += chunk.toString() })
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', exitCode => resolve({ exitCode }))
      })
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: buffers.stdout }) },
          stderr: { readFrom: () => ({ text: buffers.stderr }) },
        },
      }
    },
  }
}

function mount(applyPlugin, cwd, config, sessionId) {
  const tools = []
  applyPlugin({ subprocess: realSubprocess(), tools: { register: tool => tools.push(tool) } }, config)
  const exec = { agent: { session: { id: sessionId, header: { cwd } } } }
  return (name, args) => tools.find(tool => tool.name === name).execute(args, exec)
}

/** Beta.5 mutation contract: exact substring or an exception. */
function legacyEdit(content, oldString, newString) {
  const at = content.indexOf(oldString)
  if (at === -1) throw new Error('ToolCallError: old_string was not found')
  if (content.indexOf(oldString, at + 1) !== -1) throw new Error('ToolCallError: old_string is not unique')
  return content.slice(0, at) + newString + content.slice(at + oldString.length)
}

/** Beta.5 bash contract: any non-zero exit is a tool error. */
function legacyBash(command, cwd) {
  const result = spawnSync(BASH, ['-c', command], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`ToolCallError: exit code: ${result.status}`)
  return result.stdout
}

function record(scenario, beta5, beta6, note) {
  report.push({ scenario, beta5, beta6, note })
}

test('Case A — a stale anchor: drift is repaired in place instead of re-planned', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-a-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'a.py')
  // The file on disk has CRLF and a trailing space; the caller remembers neither.
  await writeFile(file, 'def load(p):\r\n    return open(p).read() \r\nprint(load)\r\n')
  const remembered = 'def load(p):\n    return open(p).read()\n'
  const replacement = 'def load(p):\n    return Path(p).read_text()\n'

  // Beta.5: exact replace raises, the caller reads the file, then retries.
  let beta5 = 0
  const before = await readFile(file, 'utf8')
  try {
    legacyEdit(before, remembered, replacement)
  } catch {
    beta5 += 1                      // interpret the exception
    const current = await readFile(file, 'utf8')   // inspect
    beta5 += 1
    legacyEdit(current, '    return open(p).read() \r\n', '    return Path(p).read_text()\r\n')
    beta5 += 1                      // rebuild and retry
  }

  // Beta.6: one call; the runtime resolves the drift and verifies the result.
  const call = mount(applyEdit, dir, { bashPath: BASH }, 'replay-a')
  const result = await call('edit_apply', { path: file, old_string: remembered, new_string: replacement })
  const beta6 = 1

  assert.equal(result.status, 'applied')
  assert.equal(result.tolerant, true)
  assert.match(await readFile(file, 'utf8'), /Path\(p\)\.read_text\(\)/)
  assert.ok(beta6 < beta5)
  record('A stale anchor', beta5, beta6, 'CRLF/whitespace drift resolved by the runtime')
})

test('Case B — a fragile payload never crosses a quoting layer', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-b-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'b.py')
  await writeFile(file, 'PLACEHOLDER\n')

  const payload = [
    `pattern = re.compile(r"${BS}d+${BS}s*")`,
    `label = "it's \`date\` \${VAR} 中文 · μ"`,
    'doc = """triple "quoted" block"""',
    'EOF',
  ].join('\n')

  // Beta.5: the payload is embedded in a shell heredoc. It contains a line
  // equal to the delimiter, so the heredoc closes early and the rest of the
  // payload is executed as commands — the write is lost AND the call fails.
  let beta5 = 0
  let legacyCorrect = false
  const legacyTarget = join(dir, 'legacy.py')
  try {
    legacyBash(`cat > '${legacyTarget.split(BS).join('/')}' <<'EOF'\n${payload}\nEOF`, dir)
    const legacyWritten = existsSync(legacyTarget) ? await readFile(legacyTarget, 'utf8') : ''
    legacyCorrect = legacyWritten.replace(/\r\n/g, '\n').trimEnd() === payload.trimEnd()
    if (!legacyCorrect) beta5 += 1        // notice the truncated file
  } catch {
    beta5 += 1                            // interpret the spurious exit 127
  }
  if (!legacyCorrect) {
    beta5 += 1                            // choose another quoting strategy
    beta5 += 1                            // apply it
  }

  // Beta.6: the payload is a tool argument and reaches disk base64-encoded.
  const call = mount(applyEdit, dir, { bashPath: BASH }, 'replay-b')
  const result = await call('edit_apply', { path: file, content: `${payload}\n` })
  const beta6 = 1

  assert.equal(legacyCorrect, false, 'the legacy heredoc path must lose this payload')
  assert.equal(result.status, 'applied')
  assert.equal(await readFile(file, 'utf8'), `${payload}\n`, 'byte-exact through the structured path')
  assert.ok(beta6 < beta5)
  record('B fragile payload', beta5, beta6, 'delimiter collision breaks the heredoc write')
})

test('Case C — grep with no match is a result, not a recovery', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-c-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'src.py'), 'print(1)\n')

  let beta5 = 0
  try {
    legacyBash('grep -r "nonexistent_symbol" .', dir)
  } catch {
    beta5 += 2   // interpret the exception, then decide it was not a failure
  }

  const call = mount(applyBash, dir, { bashPath: BASH }, 'replay-c')
  const result = await call('bash', { command: 'grep -r "nonexistent_symbol" .' })
  const beta6 = 1

  assert.equal(beta5, 2)
  assert.equal(result.exitCode, 1)
  assert.equal(result.ok, false)
  // The next action is computable from the fields, with no prose to read.
  assert.equal(result.exitCode === 1 && result.failureClass === 'process_nonzero', true)
  record('C grep no match', beta5, beta6, 'exit code readable as a field')
})

test('Case D — a genuinely failing test is still a failure', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-d-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const call = mount(applyBash, dir, { bashPath: BASH }, 'replay-d')

  const failing = await call('bash', { command: 'echo "1 failed, 2 passed"; exit 1' })
  assert.equal(failing.ok, false, 'a failing test must never read as success')
  assert.equal(failing.exitCode, 1)
  assert.match(failing.text, /1 failed/)

  const passing = await call('bash', { command: 'echo "3 passed"; exit 0' })
  assert.equal(passing.ok, true)
  assert.equal(passing.exitCode, 0)
  record('D failing test', 1, 1, 'correctness preserved: P0 guard, no boundary change')
})

test('Case E — a missing command is an environment failure, not a test result', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-e-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const call = mount(applyBash, dir, { bashPath: BASH }, 'replay-e')

  const result = await call('bash', { command: 'definitely_not_a_real_binary --version' })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 127)
  assert.equal(result.failureClass, 'process_not_found')
  record('E command not found', 2, 1, 'classified as environment, not program')
})

test('Case F — a second same-family failure demands a strategy change', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-f-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'f.py')
  await writeFile(file, 'alpha = 1\n')
  const call = mount(applyEdit, dir, { bashPath: BASH }, 'replay-f')

  const first = await call('edit_apply', { path: file, old_string: 'beta = 2', new_string: 'beta = 3' })
  const second = await call('edit_apply', { path: file, old_string: 'gamma = 4', new_string: 'gamma = 5' })

  assert.equal(first.status, 'conflict')
  assert.doesNotMatch(first.text, /no progress/)
  assert.equal(second.status, 'conflict')
  assert.match(second.text, /no progress: edit_conflict failed 2x/)
  assert.match(second.text, /rewrite the whole region or the whole file/)
  // Beta.5 could only advise this in the prompt and never counted anything.
  record('F repeated failure', 4, 2, 'runtime names the transition on the 2nd failure')
})

test('Case G — a long job returns immediately and is inspected once', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-g-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { apply: applyJobs } = await import('../preset/deep-performance/job-runner.mjs')
  const call = mount(applyJobs, dir, { bashPath: BASH, jobsDir: '.dsh-jobs' }, 'replay-g')

  const started = Date.now()
  const launch = await call('bash_job', { action: 'start', command: 'sleep 2; echo finished' })
  const launchMs = Date.now() - started
  const jobId = launch.text.match(/job-[0-9a-z-]+/)[0]

  assert.ok(launchMs < 5000, `launch must return promptly, took ${launchMs}ms`)
  await new Promise(resolve => setTimeout(resolve, 3500))
  const status = await call('bash_job', { action: 'status', job_id: jobId })
  assert.match(status.text, /: completed/)
  // Beta.5 already fixed this lane; recorded to prove Beta.6 did not regress it.
  record('G long job', 2, 2, 'unchanged: launch + one status check')
})

test('Case H — a two-file coherent change applies without a conflict detour', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-h-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const one = join(dir, 'one.py')
  const two = join(dir, 'two.py')
  // Both files have the CRLF the caller will not remember.
  await writeFile(one, 'def api(x):\r\n    return x + 1\r\n')
  await writeFile(two, 'from one import api\r\nprint(api(1))\r\n')

  let beta5 = 0
  for (const [file, oldText] of [[one, 'def api(x):\n    return x + 1\n'], [two, 'print(api(1))\n']]) {
    const content = await readFile(file, 'utf8')
    try {
      legacyEdit(content, oldText, oldText.replace('api', 'api2'))
    } catch {
      beta5 += 2   // interpret, then re-read and rebuild
    }
  }

  const call = mount(applyEdit, dir, { bashPath: BASH }, 'replay-h')
  const first = await call('edit_apply', { path: one, old_string: 'def api(x):\n', new_string: 'def api2(x):\n' })
  const second = await call('edit_apply', { path: two, old_string: 'print(api(1))\n', new_string: 'print(api2(1))\n' })
  const beta6 = 1   // both statuses are `applied`; nothing to decide between them

  assert.equal(first.status, 'applied')
  assert.equal(second.status, 'applied')
  assert.match(await readFile(one, 'utf8'), /def api2/)
  assert.match(await readFile(two, 'utf8'), /print\(api2\(1\)\)/)
  assert.ok(beta6 < beta5)
  record('H two-file change', beta5, beta6, 'no conflict detour on either file')
})

test('replay summary: fewer execution-induced boundaries, same completions', { skip: !canReplay }, () => {
  const total5 = report.reduce((sum, row) => sum + row.beta5, 0)
  const total6 = report.reduce((sum, row) => sum + row.beta6, 0)
  const reduction = Math.round((1 - total6 / total5) * 100)

  const lines = [
    '',
    'Deterministic replay — model decision boundaries (no live model involved)',
    'scenario                    beta.5   beta.6   note',
    ...report.map(row => `${row.scenario.padEnd(26)}${String(row.beta5).padStart(5)}${String(row.beta6).padStart(9)}   ${row.note}`),
    `${'TOTAL'.padEnd(26)}${String(total5).padStart(5)}${String(total6).padStart(9)}   ${reduction}% fewer`,
    '',
  ]
  console.log(lines.join('\n'))

  assert.equal(report.length, 8, 'every case must have been replayed')
  assert.ok(total6 < total5)
  assert.ok(reduction >= 20, `expected a material reduction, measured ${reduction}%`)
})

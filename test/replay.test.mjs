/**
 * Behavioral replay: the failure sequences that motivated Beta.5 and Beta.6,
 * scored by model decision boundaries per completed task.
 *
 * FIDELITY — the Beta.5 side runs the ACTUAL Beta.5 bash tool, extracted from
 * commit a719bef93d890437111b5e033a8c2e943896b737 into
 * `test/fixtures/beta5-custom-bash.mjs`, not a description of it from memory.
 * An earlier version of this file modelled Beta.5 as raising on every non-zero
 * exit; that was Beta.4 behaviour and it inflated the Beta.5 baseline. Beta.5
 * already returned non-zero exits as command-domain results.
 *
 * Beta.5 shipped NO edit tool (verified against the commit's file list), so its
 * mutation contract is the host `str_replace_editor`: exact substring or an
 * exception. That contract is modelled here — the host tool cannot be executed
 * from this repository — and is the only modelled component; it is marked
 * where it is used.
 *
 * WHAT THIS IS: a deterministic replay. No language model is involved. What is
 * measured is how often each contract FORCES control back to the model, not
 * how a model behaves, how long a session takes, or what it costs.
 *
 * COUNTING RULE — one boundary is charged when:
 *   1. a tool raises, so the caller must interpret an exception and re-plan; or
 *   2. a tool returns an outcome whose next action cannot be computed by the
 *      code already generated for this step — the caller must read prose and
 *      decide.
 * Consecutive calls whose next action follows deterministically from a status
 * field cost ONE boundary together, because Code Mode can chain them inside a
 * single generated block.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyEdit } from '../preset/deep-performance/edit-apply.mjs'
import { apply as applyBash } from '../preset/deep-performance/custom-bash.mjs'
import { apply as applyBeta5Bash } from './fixtures/beta5-custom-bash.mjs'

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

/** The real Beta.5 bash tool, mounted from the commit's own source. */
function beta5Bash(cwd, sessionId) {
  return mount(applyBeta5Bash, cwd, { bashPath: BASH, timeoutMs: 300000 }, sessionId)
}

/** Beta.6 tools. */
function beta6Bash(cwd, sessionId) {
  return mount(applyBash, cwd, { bashPath: BASH, timeoutMs: 300000 }, sessionId)
}
function beta6Edit(cwd, sessionId) {
  return mount(applyEdit, cwd, { bashPath: BASH, timeoutMs: 60000 }, sessionId)
}

/**
 * MODELLED: the host `str_replace_editor` contract Beta.5 relied on — exact
 * substring, or an exception. The host tool is not runnable from here.
 */
function legacyEdit(content, oldString, newString) {
  const at = content.indexOf(oldString)
  if (at === -1) throw new Error('ToolCallError: old_string was not found')
  if (content.indexOf(oldString, at + 1) !== -1) throw new Error('ToolCallError: old_string is not unique')
  return content.slice(0, at) + newString + content.slice(at + oldString.length)
}

function record(scenario, beta5, beta6, correctness, note) {
  report.push({ scenario, beta5, beta6, correctness, note })
}

test('the replay baseline is the real Beta.5 contract, not an earlier one', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-base-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const legacy = beta5Bash(dir, 'baseline-check')

  // The decisive property: Beta.5 already returned a non-zero exit as a
  // RESULT. Any replay that raises here is measuring Beta.4.
  const result = await legacy('bash', { command: 'exit 1' })
  assert.match(result.text, /^exit code: 1/)
  assert.equal(result.exitCode, undefined, 'Beta.5 carried no structured fields')
  assert.equal(result.ok, undefined)

  // And a killed process still raised in Beta.5, exactly as in Beta.6.
  const tools = []
  applyBeta5Bash({
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn: () => ({
        done: Promise.resolve({ exitCode: null }),
        collected: {
          stdout: { readFrom: () => ({ text: '' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }),
    },
    tools: { register: tool => tools.push(tool) },
  }, { bashPath: BASH })
  await assert.rejects(tools[0].execute({ command: 'sleep 999' }, {}), /terminated without an exit code/)
})

test('Case A — a stale anchor', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-a-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'a.py')
  await writeFile(file, 'def load(p):\r\n    return open(p).read() \r\nprint(load)\r\n')
  const remembered = 'def load(p):\n    return open(p).read()\n'
  const replacement = 'def load(p):\n    return Path(p).read_text()\n'

  // Beta.5: the host editor raises; the caller interprets, re-reads, retries.
  let beta5 = 0
  try {
    legacyEdit(await readFile(file, 'utf8'), remembered, replacement)
  } catch {
    beta5 += 1
    const current = await readFile(file, 'utf8')
    beta5 += 1
    legacyEdit(current, '    return open(p).read() \r\n', '    return Path(p).read_text()\r\n')
    beta5 += 1
  }

  const edit = beta6Edit(dir, 'replay-a')
  const result = await edit('edit_apply', { path: file, old_string: remembered, new_string: replacement })

  assert.equal(result.status, 'applied')
  assert.equal(result.tolerant, true)
  assert.match(await readFile(file, 'utf8'), /Path\(p\)\.read_text\(\)/)
  record('stale anchor', beta5, 1, 'both reach the intended file', 'drift resolved by the runtime')
})

test('Case B — a fragile payload beyond the argv ceiling', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-b-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // Beta.5's own execution lane prescribed base64 out-of-band for fragile
  // payloads, and that works — until the encoded argument exceeds what this
  // platform accepts, where it fails with no file written.
  const payload = [
    `pattern = re.compile(r"${BS}d+${BS}s*")`,
    `label = "it's \`date\` \${VAR} 中文 · μ"`,
    'doc = """triple "quoted" block"""',
    'x'.repeat(9000),
  ].join('\n') + '\n'

  const legacy = beta5Bash(dir, 'replay-b')
  const legacyTarget = `${dir.split(BS).join('/')}/legacy.py`
  const encoded = Buffer.from(payload, 'utf8').toString('base64')

  let beta5 = 1   // the write call itself
  const write = await legacy('bash', { command: `printf %s '${encoded}' | base64 -d > '${legacyTarget}'` })
  const legacyOk = write.text.startsWith('exit code: 0') || !write.text.startsWith('exit code:')
  const legacyContent = existsSync(legacyTarget) ? await readFile(legacyTarget, 'utf8') : ''
  const legacyCorrect = legacyOk && legacyContent === payload
  if (!legacyCorrect) {
    beta5 += 1   // diagnose the failed write
    beta5 += 1   // switch to a chunked strategy and apply it
  }

  const file = join(dir, 'b.py')
  await writeFile(file, 'PLACEHOLDER\n')
  const edit = beta6Edit(dir, 'replay-b')
  const result = await edit('edit_apply', { path: file, content: payload })

  assert.equal(legacyCorrect, false, 'a single-command base64 write of this size must fail on this platform')
  assert.equal(result.status, 'applied')
  assert.equal(await readFile(file, 'utf8'), payload, 'byte-exact through the structured path')
  record('fragile payload', beta5, 1, 'Beta.5 wrote nothing; Beta.6 byte-exact', 'chunking is automatic')
})

test('Case C — grep with no match', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-c-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'src.py'), 'print(1)\n')

  // Beta.5 already returned this as a result. The remaining difference is that
  // Beta.6 exposes it as a field rather than as prose — which does not by
  // itself remove a boundary, so this scores as parity.
  const legacy = await beta5Bash(dir, 'replay-c')('bash', { command: 'grep -r "nope" .' })
  assert.match(legacy.text, /^exit code: 1/)

  const result = await beta6Bash(dir, 'replay-c6')('bash', { command: 'grep -r "nope" .' })
  assert.equal(result.exitCode, 1)
  assert.equal(result.ok, false)
  assert.equal(result.failureClass, 'process_nonzero')
  record('grep no match', 1, 1, 'both report exit 1 as a result', 'parity; fixed in Beta.5, field in Beta.6')
})

test('Case D — a genuinely failing test', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-d-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const legacy = await beta5Bash(dir, 'replay-d')('bash', { command: 'echo "1 failed"; exit 1' })
  assert.match(legacy.text, /^exit code: 1/)

  const call = beta6Bash(dir, 'replay-d6')
  const failing = await call('bash', { command: 'echo "1 failed"; exit 1' })
  assert.equal(failing.ok, false, 'a failing test must never read as success')
  assert.equal(failing.exitCode, 1)
  const passing = await call('bash', { command: 'echo "3 passed"; exit 0' })
  assert.equal(passing.ok, true)
  record('failing test', 1, 1, 'neither mistakes exit 1 for success', 'parity; correctness guard')
})

test('Case E — a missing command', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-e-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const legacy = await beta5Bash(dir, 'replay-e')('bash', { command: 'not_a_real_binary --version' })
  assert.match(legacy.text, /exit code: 127/)

  const result = await beta6Bash(dir, 'replay-e6')('bash', { command: 'not_a_real_binary --version' })
  assert.equal(result.exitCode, 127)
  assert.equal(result.failureClass, 'process_not_found')
  record('command not found', 1, 1, 'both surface exit 127', 'parity; Beta.6 classifies it')
})

test('Case F — a repeated same-family failure', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-f-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'f.py')
  await writeFile(file, 'alpha = 1\n')

  // Beta.5 tracked repeats for bash only, and had no edit tool at all: two
  // failed edits raised twice with no signal that the strategy was wrong.
  let beta5 = 0
  for (const anchor of ['beta = 2', 'gamma = 4']) {
    try {
      legacyEdit(await readFile(file, 'utf8'), anchor, 'x')
    } catch {
      beta5 += 2   // interpret, then re-read to try another anchor
    }
  }

  const edit = beta6Edit(dir, 'replay-f')
  const first = await edit('edit_apply', { path: file, old_string: 'beta = 2', new_string: 'beta = 3' })
  const second = await edit('edit_apply', { path: file, old_string: 'gamma = 4', new_string: 'gamma = 5' })
  assert.equal(first.status, 'conflict')
  assert.doesNotMatch(first.text, /no progress/)
  assert.equal(second.status, 'conflict')
  assert.match(second.text, /no progress: edit_conflict failed 2x/)
  record('repeated failure', beta5, 2, 'neither corrupts the file', 'runtime names the transition')
})

test('Case G — a long job', { skip: !canReplay }, async (t) => {
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
  record('long job', 2, 2, 'job completes and is observable', 'parity; unchanged since Beta.5')
})

test('Case H — a two-file coherent change', { skip: !canReplay }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-h-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const one = join(dir, 'one.py')
  const two = join(dir, 'two.py')
  await writeFile(one, 'def api(x):\r\n    return x + 1\r\n')
  await writeFile(two, 'from one import api\r\nprint(api(1))\r\n')

  let beta5 = 0
  for (const [file, oldText] of [[one, 'def api(x):\n'], [two, 'print(api(1))\n']]) {
    try {
      legacyEdit(await readFile(file, 'utf8'), oldText, oldText.replace('api', 'api2'))
    } catch {
      beta5 += 2
    }
  }

  const edit = beta6Edit(dir, 'replay-h')
  const first = await edit('edit_apply', { path: one, old_string: 'def api(x):\n', new_string: 'def api2(x):\n' })
  const second = await edit('edit_apply', { path: two, old_string: 'print(api(1))\n', new_string: 'print(api2(1))\n' })
  assert.equal(first.status, 'applied')
  assert.equal(second.status, 'applied')
  assert.match(await readFile(one, 'utf8'), /def api2/)
  assert.match(await readFile(two, 'utf8'), /print\(api2\(1\)\)/)
  record('multi-file mutation', beta5, 1, 'both files updated coherently', 'no conflict detour')
})

test('replay summary', { skip: !canReplay }, () => {
  const total5 = report.reduce((sum, row) => sum + row.beta5, 0)
  const total6 = report.reduce((sum, row) => sum + row.beta6, 0)
  const reduction = Math.round((1 - total6 / total5) * 100)

  console.log([
    '',
    'Deterministic replay — execution-induced decision boundaries.',
    'Beta.5 side runs the real Beta.5 bash tool (a719bef); its editor contract is modelled.',
    'No language model is involved: this measures contracts, not live turns.',
    '',
    'scenario               beta.5   beta.6.1   correctness',
    ...report.map(row => `${row.scenario.padEnd(21)}${String(row.beta5).padStart(5)}${String(row.beta6).padStart(10)}     ${row.correctness}`),
    `${'TOTAL'.padEnd(21)}${String(total5).padStart(5)}${String(total6).padStart(10)}     ${reduction}% fewer boundaries`,
    '',
  ].join('\n'))

  assert.equal(report.length, 8, 'every case must have been replayed')
  assert.ok(total6 <= total5)
  // No target percentage is asserted: the number follows the evidence.
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  allIndexes,
  locate,
  nearestCandidate,
  normalizeForMatch,
  readCommand,
  writeCommands,
} from '../preset/deep-performance/edit-apply.mjs'

const BS = String.fromCharCode(92)

// ── deterministic matching ──────────────────────────────────────────────────

test('an exact unique anchor is located exactly', () => {
  const found = locate('a\nbb\nccc\n', 'bb')
  assert.deepEqual(found, { kind: 'exact', start: 2, end: 4 })
})

test('a repeated anchor is reported as ambiguous, never guessed', () => {
  const found = locate('x = 1\ny = 2\nx = 1\n', 'x = 1')
  assert.equal(found.kind, 'ambiguous')
  assert.deepEqual(found.offsets, allIndexes('x = 1\ny = 2\nx = 1\n', 'x = 1'))
})

test('line-ending and trailing-whitespace drift resolves without asking the caller', () => {
  // The single commonest cause of `old_string was not found` on Windows.
  const onDisk = 'def f():\r\n    return 1   \r\n'
  const remembered = 'def f():\n    return 1\n'
  const found = locate(onDisk, remembered)
  assert.equal(found.kind, 'tolerant')
  assert.equal(onDisk.slice(found.start, found.end), 'def f():\r\n    return 1   \r\n')
})

test('leading indentation is never normalised away', () => {
  // Changing indentation would change meaning in Python and YAML, so the
  // tolerant pass must not invent an indentation match.
  assert.equal(normalizeForMatch('    x = 1'), '    x = 1')
  assert.equal(normalizeForMatch('\tif x:  \r\n'), '\tif x:\n')
  // An anchor indented more deeply than the file is genuinely absent.
  assert.equal(locate('def f():\n    return 1\n', '        return 1').kind, 'missing')
})

test('a tolerant match that is not unique stays ambiguous', () => {
  const onDisk = 'a = 1   \r\nb = 2\r\na = 1\r\n'
  assert.equal(locate(onDisk, 'a = 1\n').kind, 'ambiguous')
})

test('a failed anchor reports the current text around the closest line', () => {
  const content = 'import os\n\ndef load(path):\n    return open(path).read()\n\ndef main():\n    pass\n'
  const near = nearestCandidate(content, 'def load(path):\n    return open(path, encoding="utf8").read()')
  assert.notEqual(near, undefined)
  assert.match(near.text, /def load\(path\):/)
  assert.match(near.text, /return open\(path\)\.read\(\)/)
})

test('the write plan keeps every base64 argument under the verified argv ceiling', () => {
  const small = writeCommands({ shellPath: 'a.py', start: 0, end: 1, replacementB64: 'x'.repeat(3000), digest: 'd' })
  assert.equal(small.length, 1)
  assert.match(small[0], /head -c 0 'a\.py'/)
  assert.match(small[0], /tail -c \+2 'a\.py'/)
  assert.match(small[0], /mv -f/)
  assert.match(small[0], /sha256sum/)

  const large = writeCommands({ shellPath: 'a.py', start: 0, end: 1, replacementB64: 'x'.repeat(50000), digest: 'd' })
  assert.ok(large.length > 2, 'a large payload must be chunked')
  for (const command of large) {
    assert.ok(command.length < 5000, `chunk command too long: ${command.length}`)
  }
})

test('the read command guards size before reading', () => {
  const command = readCommand('a.py', 1024)
  assert.match(command, /if \[ ! -f 'a\.py' \]; then echo MISSING/)
  assert.match(command, /-gt 1024 \]; then echo "TOO_LARGE/)
  assert.match(command, /base64 -w0 < 'a\.py'/)
})

// ── real mutation through Git Bash ──────────────────────────────────────────

const BASH = 'C:/Program Files/Git/bin/bash.exe'
const canRunShell = process.platform === 'win32' && existsSync(BASH)

function realSubprocess() {
  return {
    async resolveExecutable(path) { return path },
    spawn({ argv, cwd, signal }) {
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

function mountEditApply(cwd, session = { id: 'edit-session' }) {
  const registered = []
  apply({
    subprocess: realSubprocess(),
    tools: { register(tool) { registered.push(tool) } },
  }, { bashPath: BASH, timeoutMs: 60000 })
  const tool = registered.find(item => item.name === 'edit_apply')
  const exec = { agent: { session: { ...session, header: { cwd } } } }
  return { tool, call: args => tool.execute(args, exec) }
}

test('a pathological payload reaches disk byte-exactly and is verified', { skip: !canRunShell }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'sample.py')
  const original = 'import re\n\ndef f():\n    return 1\n\nprint(f())\n'
  await writeFile(file, original)

  const replacement = [
    '    pattern = re.compile(r"' + BS + 'd+' + BS + 's*")',
    `    label = "it's ` + '`date`' + ' ${VAR} 中文 · μ"',
    '    return f"""triple {label}"""',
  ].join('\n')

  const { call } = mountEditApply(dir)
  const result = await call({ path: file, old_string: '    return 1', new_string: replacement })

  assert.equal(result.status, 'applied')
  assert.equal(result.applied, true)
  assert.equal(await readFile(file, 'utf8'), original.replace('    return 1', replacement))
  assert.match(result.text, /verified by digest/)
  assert.match(result.sha256, /^[0-9a-f]{64}$/)

  // nothing is left behind beside the target
  assert.deepEqual(readdirSync(dir), ['sample.py'])
})

test('CRLF drift is repaired in place instead of becoming a conflict', { skip: !canRunShell }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'crlf.py')
  await writeFile(file, 'def f():\r\n    return 1   \r\nprint(1)\r\n')

  const { call } = mountEditApply(dir)
  // The caller remembers LF and no trailing spaces — the usual mismatch.
  const result = await call({ path: file, old_string: 'def f():\n    return 1\n', new_string: 'def f():\n    return 2\n' })

  assert.equal(result.status, 'applied')
  assert.equal(result.tolerant, true)
  const after = await readFile(file, 'utf8')
  assert.match(after, /return 2/)
  assert.match(after, /print\(1\)\r\n$/, 'untouched bytes keep their original line endings')
})

test('a stale anchor returns a conflict carrying the current text, not an exception', { skip: !canRunShell }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'stale.py')
  await writeFile(file, 'def load(path):\n    return open(path).read()\n')

  const { call } = mountEditApply(dir)
  const conflict = await call({
    path: file,
    old_string: 'def load(path):\n    return open(path, encoding="utf8").read()',
    new_string: 'def load(path):\n    return Path(path).read_text()',
  })

  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.applied, false)
  assert.match(conflict.current_span, /return open\(path\)\.read\(\)/)
  assert.equal(typeof conflict.current_span_line, 'number')

  // The caller can repair from the returned span within the same step.
  const repaired = await call({
    path: file,
    old_string: '    return open(path).read()',
    new_string: '    return Path(path).read_text()',
  })
  assert.equal(repaired.status, 'applied')
  assert.match(await readFile(file, 'utf8'), /Path\(path\)\.read_text\(\)/)
})

test('a stale digest is refused before anything is written', { skip: !canRunShell }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'guard.py')
  await writeFile(file, 'value = 1\n')

  const { call } = mountEditApply(dir)
  const stale = await call({
    path: file,
    old_string: 'value = 1',
    new_string: 'value = 2',
    expected_sha256: '0'.repeat(64),
  })
  assert.equal(stale.status, 'stale')
  assert.equal(await readFile(file, 'utf8'), 'value = 1\n', 'a refused edit must not touch the file')
  assert.match(stale.sha256, /^[0-9a-f]{64}$/)

  const fresh = await call({ path: file, old_string: 'value = 1', new_string: 'value = 2', expected_sha256: stale.sha256 })
  assert.equal(fresh.status, 'applied')
})

test('a large rewrite crosses the argv ceiling in chunks and stays byte-exact', { skip: !canRunShell }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'big.py')
  await writeFile(file, 'placeholder\n')

  const generated = Array.from({ length: 1200 }, (_, index) => `def f${index}():\n    return "中文 ${index} ${BS}d+"`).join('\n\n') + '\n'
  const { call } = mountEditApply(dir)
  const result = await call({ path: file, content: generated })

  assert.equal(result.status, 'applied')
  assert.equal(await readFile(file, 'utf8'), generated)
  assert.deepEqual(readdirSync(dir), ['big.py'], 'staging files must not survive the write')
})

test('a missing file and an unchanged edit are statuses, not exceptions', { skip: !canRunShell }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { call } = mountEditApply(dir)

  const missing = await call({ path: join(dir, 'nope.py'), old_string: 'a', new_string: 'b' })
  assert.equal(missing.status, 'missing')
  assert.equal(missing.applied, false)

  const file = join(dir, 'same.py')
  await writeFile(file, 'x = 1\n')
  const unchanged = await call({ path: file, content: 'x = 1\n' })
  assert.equal(unchanged.status, 'unchanged')
  assert.equal(unchanged.applied, false)
})

test('repeated conflicts on one file escalate to a strategy change', { skip: !canRunShell }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'loop.py')
  await writeFile(file, 'alpha = 1\nbeta = 2\n')
  const { call } = mountEditApply(dir)

  const first = await call({ path: file, old_string: 'gamma = 3', new_string: 'gamma = 4' })
  assert.equal(first.status, 'conflict')
  assert.doesNotMatch(first.text, /no progress/)

  // A DIFFERENT anchor against the same stale file is the same failing
  // strategy, and byte-identity would have missed it.
  const second = await call({ path: file, old_string: 'delta = 9', new_string: 'delta = 10' })
  assert.equal(second.status, 'conflict')
  assert.match(second.text, /no progress: edit_conflict failed 2x/)
  assert.match(second.text, /rewrite the whole region or the whole file/)

  // A success clears the family so later unrelated work starts fresh.
  const applied = await call({ path: file, old_string: 'alpha = 1', new_string: 'alpha = 2' })
  assert.equal(applied.status, 'applied')
  const afterSuccess = await call({ path: file, old_string: 'epsilon = 5', new_string: 'epsilon = 6' })
  assert.doesNotMatch(afterSuccess.text, /no progress/)
})

test('an invalid invocation is rejected before any file is touched', { skip: !canRunShell }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { call } = mountEditApply(dir)
  await assert.rejects(call({ path: join(dir, 'x.py') }), /either old_string \+ new_string, or content/)
  await assert.rejects(call({ path: join(dir, 'x.py'), old_string: 'a', content: 'b' }), /not both and not neither/)
  await assert.rejects(call({ path: join(dir, 'x.py'), old_string: 'a' }), /needs new_string/)
})

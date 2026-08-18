/**
 * Release hardening regressions for `edit_apply`.
 *
 * Each test states a failure invariant that must hold for a mutation tool used
 * on real work: bytes are what the caller intended, a stale writer never wins,
 * staging never collides, a filename is never shell syntax, and nothing is
 * left behind. These run against real files through real Git Bash.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, resolveTarget, matchLineEndings } from '../preset/deep-performance/edit-apply.mjs'

const BASH = 'C:/Program Files/Git/bin/bash.exe'
const BS = String.fromCharCode(92)
const canRun = process.platform === 'win32' && existsSync(BASH)
const sha = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

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

function mountEdit(cwd, config = {}, sessionId = 'integrity') {
  const tools = []
  apply({ subprocess: realSubprocess(), tools: { register: tool => tools.push(tool) } },
    { bashPath: BASH, timeoutMs: 60000, ...config })
  const tool = tools.find(item => item.name === 'edit_apply')
  const exec = { agent: { session: { id: sessionId, header: { cwd } } } }
  return args => tool.execute(args, exec)
}

async function workspace(t, prefix = 'integrity') {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${prefix}-`))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** No staging artifact may survive any outcome. */
async function assertNoStagingLeft(dir) {
  const entries = await readdir(dir)
  const leftovers = entries.filter(name => name.includes('.dsh-edit'))
  assert.deepEqual(leftovers, [], `staging files left behind: ${leftovers.join(', ')}`)
}

// ── path containment ────────────────────────────────────────────────────────

test('workspace containment uses canonical semantics, not prefix matching', () => {
  // The classic prefix bug: D:\work2 is NOT inside D:\work.
  assert.equal(resolveTarget('file.py', 'D:\\work').ok, true)
  assert.equal(resolveTarget('sub/file.py', 'D:\\work').ok, true)
  assert.equal(resolveTarget('D:\\work2\\file.py', 'D:\\work').ok, false)
  assert.equal(resolveTarget('..\\outside.txt', 'D:\\work').ok, false)
  assert.equal(resolveTarget('../../outside.txt', 'D:\\work').ok, false)
  assert.equal(resolveTarget('sub/../../outside.txt', 'D:\\work').ok, false)
  assert.equal(resolveTarget('C:\\Windows\\System32\\drivers\\etc\\hosts', 'D:\\work').ok, false)
  // The workspace root itself is not an editable file.
  assert.equal(resolveTarget('D:\\work', 'D:\\work').ok, false)
  // Windows paths compare case-insensitively, because the filesystem does.
  if (process.platform === 'win32') {
    assert.equal(resolveTarget('d:\\WORK\\file.py', 'D:\\work').ok, true)
  }
  // An explicit deployment decision can widen the scope; nothing else can.
  assert.equal(resolveTarget('../outside.txt', 'D:\\work', true).ok, true)
  assert.equal(resolveTarget('', 'D:\\work').ok, false)
})

test('a path outside the workspace is refused before anything is read', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'path')
  const outside = join(dir, '..', `escape-${Date.now()}.txt`)
  const call = mountEdit(dir)
  await assert.rejects(call({ path: outside, content: 'owned' }), /outside the workspace root/)
  assert.equal(existsSync(outside), false, 'a refused edit must not create the file')
  await assert.rejects(call({ path: '../../etc/hosts', content: 'x' }), /outside the workspace root/)
})

// ── unicode / offsets ───────────────────────────────────────────────────────

test('non-BMP characters do not corrupt byte offsets', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'unicode')
  const call = mountEdit(dir)

  const cases = [
    { name: 'before', original: 'ANCHOR\n😀🧬 tail\n', old: 'ANCHOR', next: 'REPLACED' },
    { name: 'after', original: '😀🧬 head\nANCHOR\n', old: 'ANCHOR', next: 'REPLACED' },
    { name: 'between', original: '😀 a\nANCHOR\n𝛼 b\n𐐷 c\n', old: 'ANCHOR', next: 'REPLACED' },
    { name: 'mixed-bmp', original: '中文 μ 😀\nANCHOR\n中文 tail\n', old: 'ANCHOR', next: '替换 🧬' },
    { name: 'emoji-in-replacement', original: 'plain\nANCHOR\nplain\n', old: 'ANCHOR', next: 'a😀b𝛼c𐐷d' },
    { name: 'replace-the-emoji', original: 'x😀y\n', old: '😀', next: '🧬' },
    { name: 'adjacent-surrogates', original: '😀😀ANCHOR😀😀\n', old: 'ANCHOR', next: '🧬🧬' },
  ]

  for (const item of cases) {
    const file = join(dir, `${item.name}.txt`)
    await writeFile(file, item.original)
    const want = item.original.replace(item.old, item.next)
    const result = await call({ path: file, old_string: item.old, new_string: item.next })

    assert.equal(result.status, 'applied', `${item.name}: ${result.text}`)
    assert.equal(await readFile(file, 'utf8'), want, `${item.name}: file bytes differ from intent`)
    // The digest the tool reports must be the digest of what is on disk.
    assert.equal(result.sha256, sha(want), `${item.name}: reported digest is wrong`)
  }
  await assertNoStagingLeft(dir)
})

// ── data integrity across file shapes ───────────────────────────────────────

test('whole-file rewrites are byte-exact across degenerate file shapes', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'shapes')
  const call = mountEdit(dir)

  const shapes = [
    { name: 'empty', from: '', to: 'now has content\n' },
    { name: 'one-byte', from: 'x', to: 'y' },
    { name: 'no-trailing-newline', from: 'line one\nline two', to: 'line one\nline two changed' },
    { name: 'lf', from: 'a\nb\nc\n', to: 'a\nB\nc\n' },
    { name: 'crlf', from: 'a\r\nb\r\nc\r\n', to: 'a\r\nB\r\nc\r\n' },
    { name: 'to-empty', from: 'delete me\n', to: '' },
    { name: 'bmp', from: '中文 μ ± σ\n', to: '中文 μ ± σ 改\n' },
    { name: 'non-bmp', from: '😀🧬𝛼𐐷\n', to: '😀🧬𝛼𐐷 tail\n' },
  ]

  for (const shape of shapes) {
    const file = join(dir, `${shape.name}.txt`)
    await writeFile(file, shape.from)
    const result = await call({ path: file, content: shape.to })
    assert.equal(result.status, 'applied', `${shape.name}: ${result.text}`)
    assert.equal(await readFile(file, 'utf8'), shape.to, `${shape.name}: content differs`)
    assert.equal(result.sha256, sha(shape.to), `${shape.name}: digest differs`)
  }
  await assertNoStagingLeft(dir)
})

test('payloads around the chunk boundary are byte-exact', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'chunk')
  const call = mountEdit(dir)

  // The 4000-char base64 ceiling is an implementation safety margin measured on
  // this platform, not a universal constant, so the edges are tested directly.
  // 3 raw bytes encode to 4 base64 chars, so these straddle the boundary.
  for (const rawBytes of [2997, 3000, 3003, 3300, 12000]) {
    const file = join(dir, `chunk-${rawBytes}.txt`)
    await writeFile(file, 'HEAD\nANCHOR\nTAIL\n')
    const payload = 'z'.repeat(rawBytes)
    const b64Length = Buffer.from(payload, 'utf8').toString('base64').length
    const result = await call({ path: file, old_string: 'ANCHOR', new_string: payload })
    assert.equal(result.status, 'applied', `${rawBytes} (b64 ${b64Length}): ${result.text}`)
    assert.equal(await readFile(file, 'utf8'), `HEAD\n${payload}\nTAIL\n`, `${rawBytes}: content differs`)
  }
  await assertNoStagingLeft(dir)
})

// ── stale writes and concurrency ────────────────────────────────────────────

test('C1: a stale writer never silently overwrites a newer committed version', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'stale')
  const file = join(dir, 'shared.py')
  const v1 = 'value = 1\nkeep = "a"\n'
  await writeFile(file, v1)

  const editorA = mountEdit(dir, {}, 'writer-a')
  const editorB = mountEdit(dir, {}, 'writer-b')

  // Both editors are built against V1. A commits first.
  const applied = await editorA({ path: file, old_string: 'value = 1', new_string: 'value = 2' })
  assert.equal(applied.status, 'applied')
  const v2 = await readFile(file, 'utf8')

  // B was constructed against V1 and must not win: its edit does not touch the
  // same line, so a naive implementation would happily clobber A's result.
  const stale = await editorB({ path: file, old_string: 'keep = "a"', new_string: 'keep = "b"', expected_sha256: sha(v1) })
  assert.equal(stale.status, 'stale')
  assert.equal(stale.applied, false)
  assert.equal(await readFile(file, 'utf8'), v2, "the stale writer must not have replaced A's version")

  // Rebuilding against current content succeeds.
  const retry = await editorB({ path: file, old_string: 'keep = "a"', new_string: 'keep = "b"' })
  assert.equal(retry.status, 'applied')
  assert.match(await readFile(file, 'utf8'), /value = 2/)
  assert.match(await readFile(file, 'utf8'), /keep = "b"/)
  await assertNoStagingLeft(dir)
})

test('C1b: internal stale protection does not depend on the caller supplying a digest', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'stale-internal')
  const file = join(dir, 'race.txt')
  await writeFile(file, 'ORIGINAL\npadding\n')

  // Read phase happens inside the tool; an external writer then changes the
  // file before the commit. No expected_sha256 is supplied by the caller.
  const tools = []
  let intercepted = false
  const base = realSubprocess()
  apply({
    subprocess: {
      resolveExecutable: base.resolveExecutable,
      spawn(options) {
        const isCommit = String(options.argv[2]).includes('mv -f')
        if (isCommit && !intercepted) {
          intercepted = true
          // Simulate a concurrent writer landing between read and commit.
          spawn(BASH, ['-c', `printf %s 'EXTERNAL CHANGE\\n' > '${file.split(BS).join('/')}'`]).unref()
          const sleep = spawn(BASH, ['-c', 'sleep 1'])
          sleep.on('close', () => {})
        }
        return base.spawn(options)
      },
    },
    tools: { register: tool => tools.push(tool) },
  }, { bashPath: BASH, timeoutMs: 60000 })

  await new Promise(resolve => setTimeout(resolve, 50))
  const tool = tools[0]
  const result = await tool.execute(
    { path: file, old_string: 'ORIGINAL', new_string: 'MINE' },
    { agent: { session: { id: 'race', header: { cwd: dir } } } },
  )

  // Either the guard caught it (stale) or the write landed before the external
  // change. What must NEVER happen is a silent overwrite reported as applied
  // while the file holds neither version's intended content.
  const onDisk = await readFile(file, 'utf8')
  if (result.status === 'applied') {
    assert.equal(sha(onDisk), result.sha256, 'an applied edit must match the digest it reports')
    assert.equal(onDisk, 'MINE\npadding\n', 'an applied edit must have written its own intended content')
  } else {
    assert.equal(result.status, 'stale')
    assert.match(result.text, /nothing was written/)
  }
  await assertNoStagingLeft(dir)
})

test('C2/C3/C4: concurrent edits are isolated and do not corrupt each other', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'concurrent')
  const files = ['a.py', 'b.py', 'c.py', 'd.py'].map(name => join(dir, name))
  for (const file of files) await writeFile(file, 'value = 0\n')

  // C3: unrelated files edited concurrently, plus C4: one invocation fails
  // (missing anchor) while the others succeed.
  const editors = files.map((file, index) => mountEdit(dir, {}, `session-${index}`))
  const results = await Promise.all([
    editors[0]({ path: files[0], old_string: 'value = 0', new_string: 'value = 1' }),
    editors[1]({ path: files[1], old_string: 'value = 0', new_string: 'value = 2' }),
    editors[2]({ path: files[2], old_string: 'NOT PRESENT', new_string: 'x' }),
    editors[3]({ path: files[3], content: 'rewritten\n' }),
  ])

  assert.equal(results[0].status, 'applied')
  assert.equal(results[1].status, 'applied')
  assert.equal(results[2].status, 'conflict')
  assert.equal(results[3].status, 'applied')

  assert.equal(await readFile(files[0], 'utf8'), 'value = 1\n')
  assert.equal(await readFile(files[1], 'utf8'), 'value = 2\n')
  assert.equal(await readFile(files[2], 'utf8'), 'value = 0\n', 'a failed edit must not modify its target')
  assert.equal(await readFile(files[3], 'utf8'), 'rewritten\n')
  await assertNoStagingLeft(dir)

  // C2: many concurrent edits of the SAME file — every commit that reports
  // success must be consistent with the digest it reports, and the file must
  // never end up holding a partially written mixture.
  const shared = join(dir, 'shared.txt')
  await writeFile(shared, 'base\n')
  const contenders = Array.from({ length: 6 }, (_, index) =>
    mountEdit(dir, {}, `contender-${index}`)({ path: shared, content: `writer ${index}\n` }))
  const outcomes = await Promise.all(contenders)
  const finalContent = await readFile(shared, 'utf8')

  // THE integrity invariant: the file is always exactly one writer's complete
  // content. A splice that read the live target instead of a private snapshot
  // produced mixtures such as "writer 5\nr 1\n"; that must never recur.
  assert.match(finalContent, /^(base|writer \d)\n$/, `file holds a partial mixture: ${JSON.stringify(finalContent)}`)

  // Losers may report `stale` (rejected before commit) or `verify_failure`
  // (committed, then overwritten by a later writer inside the documented
  // check-to-rename window). Both are truthful non-success reports. What must
  // never happen is a FALSE SUCCESS: an `applied` whose digest is not what the
  // file ends up holding.
  const applied = outcomes.filter(item => item.status === 'applied')
  const truthfulFailures = outcomes.filter(item => item.status === 'stale' || item.status === 'verify_failure')
  assert.equal(applied.length + truthfulFailures.length, outcomes.length,
    `unexpected statuses: ${outcomes.map(item => item.status).join(', ')}`)
  assert.ok(applied.length >= 1, 'at least one concurrent edit should commit')
  for (const winner of applied) {
    assert.equal(winner.sha256, sha(finalContent),
      'an edit reported as applied must describe the content actually on disk')
  }
  for (const loser of truthfulFailures) {
    assert.equal(loser.applied, false)
  }
  await assertNoStagingLeft(dir)
})

// ── shell safety ────────────────────────────────────────────────────────────

test('a filename is data, never shell syntax', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'injection')
  const call = mountEdit(dir)
  const canary = join(dir, 'canary.txt')
  await writeFile(canary, 'intact\n')

  const hostile = [
    "quote'name.txt",
    'dollar$name.txt',
    'back`tick`.txt',
    'semi;name.txt',
    'amp&name.txt',
    'paren(name).txt',
    'space name.txt',
    'unicode-中文-😀.txt',
    'dash-start.txt',
  ]

  for (const name of hostile) {
    const file = join(dir, name)
    await writeFile(file, 'ORIGINAL\n')
    const result = await call({ path: file, old_string: 'ORIGINAL', new_string: 'EDITED' })
    assert.equal(result.status, 'applied', `${name}: ${result.text}`)
    assert.equal(await readFile(file, 'utf8'), 'EDITED\n', `${name}: content differs`)
  }

  // A command embedded in a filename must not have executed.
  assert.equal(await readFile(canary, 'utf8'), 'intact\n')
  const injection = join(dir, "x'; rm -rf .; echo '.txt")
  await writeFile(injection, 'ORIGINAL\n')
  const result = await call({ path: injection, old_string: 'ORIGINAL', new_string: 'SAFE' })
  assert.equal(result.status, 'applied')
  assert.equal(await readFile(canary, 'utf8'), 'intact\n', 'injection attempt executed shell code')
  await assertNoStagingLeft(dir)
})

test('content containing shell and JavaScript metacharacters survives verbatim', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'payload')
  const call = mountEdit(dir)
  const file = join(dir, 'payload.txt')
  await writeFile(file, 'ANCHOR\n')

  const payload = [
    `$(rm -rf /) \`whoami\` \${HOME}`,
    `single ' double " backslash ${BS} semicolon ;`,
    'EOF',
    'DSH_JOB_TEST',
    '中文 😀 𝛼',
  ].join('\n')

  const result = await call({ path: file, old_string: 'ANCHOR', new_string: payload })
  assert.equal(result.status, 'applied')
  assert.equal(await readFile(file, 'utf8'), `${payload}\n`)
  assert.equal(result.sha256, sha(`${payload}\n`))
  await assertNoStagingLeft(dir)
})

// ── line endings ────────────────────────────────────────────────────────────

test('a CRLF span keeps CRLF when the replacement is written with LF', () => {
  assert.equal(matchLineEndings('a\r\nb\r\n', 'x\ny\n'), 'x\r\ny\r\n')
  // Content that already carries CR is left exactly as the caller wrote it.
  assert.equal(matchLineEndings('a\r\nb\r\n', 'x\r\ny\n'), 'x\r\ny\n')
  // An LF file is never converted.
  assert.equal(matchLineEndings('a\nb\n', 'x\ny\n'), 'x\ny\n')
  // Single-line replacements are untouched.
  assert.equal(matchLineEndings('a\r\n', 'x'), 'x')
})

test('editing a CRLF file does not leave it mixed', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'eol')
  const file = join(dir, 'crlf.py')
  await writeFile(file, 'def f():\r\n    return 1\r\n\r\nprint(f())\r\n')
  const call = mountEdit(dir)

  const result = await call({
    path: file,
    old_string: 'def f():\n    return 1\n',
    new_string: 'def f():\n    value = 1\n    return value\n',
  })
  assert.equal(result.status, 'applied')

  const after = await readFile(file, 'utf8')
  const lfOnly = after.split('\n').filter((line, index, all) => index < all.length - 1 && !line.endsWith('\r'))
  assert.deepEqual(lfOnly, [], `file became mixed-EOL: ${JSON.stringify(after)}`)
  assert.match(after, /value = 1/)
  await assertNoStagingLeft(dir)
})

// ── failure paths preserve data ─────────────────────────────────────────────

test('every failure status leaves the target and the directory clean', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'failures')
  const call = mountEdit(dir)

  const file = join(dir, 'keep.py')
  const original = 'alpha = 1\nalpha = 1\n'
  await writeFile(file, original)

  const ambiguous = await call({ path: file, old_string: 'alpha = 1', new_string: 'alpha = 2' })
  assert.equal(ambiguous.status, 'ambiguous')
  assert.equal(await readFile(file, 'utf8'), original)

  const conflict = await call({ path: file, old_string: 'nowhere', new_string: 'x' })
  assert.equal(conflict.status, 'conflict')
  assert.equal(await readFile(file, 'utf8'), original)

  const stale = await call({ path: file, old_string: 'alpha = 1\nalpha = 1\n', new_string: 'x\n', expected_sha256: '0'.repeat(64) })
  assert.equal(stale.status, 'stale')
  assert.equal(await readFile(file, 'utf8'), original)

  const missing = await call({ path: join(dir, 'absent.py'), old_string: 'a', new_string: 'b' })
  assert.equal(missing.status, 'missing')

  const tooLarge = mountEdit(dir, { maxFileBytes: 8 })
  const big = await tooLarge({ path: file, content: 'x' })
  assert.equal(big.status, 'too_large')
  assert.equal(await readFile(file, 'utf8'), original)

  await assertNoStagingLeft(dir)
})

test('a completed mutation retires stale process-failure history', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'generation')
  const file = join(dir, 'src.py')
  await writeFile(file, 'value = 1\n')

  const { apply: applyBash } = await import('../preset/deep-performance/custom-bash.mjs')
  // ONE session object shared by both tools, exactly as a real session is:
  // failure history is keyed by session identity, so a copy would not share it.
  const session = { id: 'generation', header: { cwd: dir } }
  const exec = { agent: { session } }
  const bashTools = []
  applyBash({ subprocess: realSubprocess(), tools: { register: tool => bashTools.push(tool) } },
    { bashPath: BASH, timeoutMs: 60000 })
  const bash = args => bashTools[0].execute(args, exec)

  const tools = []
  apply({ subprocess: realSubprocess(), tools: { register: tool => tools.push(tool) } },
    { bashPath: BASH, timeoutMs: 60000 })
  const edit = args => tools[0].execute(args, exec)

  // A test fails, the source is fixed, the same test fails again for a new
  // reason. That is a new experiment, not a repeated strategy.
  const first = await bash({ command: 'echo "assert failed"; exit 1' })
  assert.doesNotMatch(first.text, /no progress/)

  const applied = await edit({ path: file, old_string: 'value = 1', new_string: 'value = 2' })
  assert.equal(applied.status, 'applied')

  const afterFix = await bash({ command: 'echo "assert failed"; exit 1' })
  assert.doesNotMatch(afterFix.text, /no progress/,
    'a rerun after a successful mutation must not be called no-progress')

  // With no state change in between, the repeat is still a repeat.
  const repeat = await bash({ command: 'echo "assert failed"; exit 1' })
  assert.match(repeat.text, /no progress: process_nonzero failed 2x/)
})

// ── fail closed without a workspace root ────────────────────────────────────

test('a session without a workspace root refuses to mutate', () => {
  // Confinement cannot be checked without a root, so the absence of one must
  // refuse the edit rather than quietly disable the restriction.
  for (const cwd of [undefined, '', null, 0]) {
    const refused = resolveTarget('anything.txt', cwd)
    assert.equal(refused.ok, false, `cwd ${JSON.stringify(cwd)} must not be treated as unconfined`)
    assert.match(refused.reason, /no workspace root/)
  }
  // An absolute path is refused on the same grounds, not silently accepted.
  assert.equal(resolveTarget('D:\anywhere\file.txt', undefined).ok, false)

  // A root that IS present still works, and an explicit opt-out still works.
  assert.equal(resolveTarget('file.txt', 'D:\work').ok, true)
  assert.equal(resolveTarget('D:\elsewhere\file.txt', undefined, true).ok, true)
})

test('the tool refuses to edit when the session has no workspace root', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'no-root')
  const file = join(dir, 'target.txt')
  await writeFile(file, 'ORIGINAL\n')

  const tools = []
  apply({ subprocess: realSubprocess(), tools: { register: tool => tools.push(tool) } },
    { bashPath: BASH, timeoutMs: 60000 })
  const rootless = { agent: { session: { id: 'rootless', header: {} } } }

  await assert.rejects(
    tools[0].execute({ path: file, old_string: 'ORIGINAL', new_string: 'OWNED' }, rootless),
    /no workspace root/,
  )
  assert.equal(await readFile(file, 'utf8'), 'ORIGINAL\n', 'a refused edit must not touch the file')

  // Configured opt-out restores the previous behaviour deliberately.
  const opened = []
  apply({ subprocess: realSubprocess(), tools: { register: tool => opened.push(tool) } },
    { bashPath: BASH, timeoutMs: 60000, allowOutsideWorkspace: true })
  const result = await opened[0].execute({ path: file, old_string: 'ORIGINAL', new_string: 'OWNED' }, rootless)
  assert.equal(result.status, 'applied')
  assert.equal(await readFile(file, 'utf8'), 'OWNED\n')
  await assertNoStagingLeft(dir)
})

// ── commit-time failures never claim an unchanged original ──────────────────

/** Mount edit_apply with a subprocess that fails one matching command. */
function mountWithFailure(cwd, shouldFail) {
  const base = realSubprocess()
  const tools = []
  apply({
    subprocess: {
      resolveExecutable: base.resolveExecutable,
      spawn(options) {
        const command = String(options.argv[2])
        const handle = base.spawn(options)
        if (!shouldFail(command)) return handle
        // Run the command for real, then report a non-zero exit — the shape a
        // kill takes after the work has already happened.
        return { ...handle, done: handle.done.then(() => ({ exitCode: 143 })) }
      },
    },
    tools: { register: tool => tools.push(tool) },
  }, { bashPath: BASH, timeoutMs: 60000 })
  const exec = { agent: { session: { id: 'commit-failure', header: { cwd } } } }
  return args => tools[0].execute(args, exec)
}

test('a commit killed after the rename never claims the original is unchanged', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'commit-kill')
  const file = join(dir, 'victim.py')
  await writeFile(file, 'value = 1\n')

  // The committing command is the one carrying `mv -f`. Let it do its work,
  // then report termination — the file HAS already been replaced.
  const call = mountWithFailure(dir, command => command.includes('mv -f'))
  const result = await call({ path: file, old_string: 'value = 1', new_string: 'value = 2' })

  assert.equal(result.status, 'commit_uncertain')
  assert.equal(result.applied, false)
  assert.match(result.text, /DISK STATE IS UNCERTAIN/)
  assert.match(result.text, /Re-read the file/)
  // The claim that would have been false: the file really did change.
  assert.doesNotMatch(result.text, /unchanged/)
  assert.equal(await readFile(file, 'utf8'), 'value = 2\n',
    'this scenario is only meaningful if the rename actually landed')
  await assertNoStagingLeft(dir)
})

test('a staging failure before the commit does claim an unchanged original, truthfully', { skip: !canRun }, async (t) => {
  const dir = await workspace(t, 'staging-fail')
  const file = join(dir, 'safe.py')
  const original = 'HEAD\nANCHOR\nTAIL\n'
  await writeFile(file, original)

  // A chunked write stages the payload in earlier commands; failing one of
  // those cannot have renamed anything.
  const call = mountWithFailure(dir, command => command.includes('.b64') && !command.includes('mv -f'))
  const result = await call({ path: file, old_string: 'ANCHOR', new_string: 'z'.repeat(9000) })

  assert.equal(result.status, 'write_failure')
  assert.match(result.text, /Nothing was committed and the original file is unchanged/)
  assert.equal(await readFile(file, 'utf8'), original, 'the claim must be true')
  await assertNoStagingLeft(dir)
})

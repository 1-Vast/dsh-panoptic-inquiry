/**
 * Transport-fragility benchmark for the Code Mode lane.
 *
 * Observed failures such as `Expected ';', got 'string literal'` and
 * `Expected a semicolon` happen BEFORE the target tool runs: the payload never
 * executed, so debugging the target program is wasted work. A payload crossing
 * into a tool call passes through two independent quoting layers —
 *
 *   layer 1  the Code Mode JavaScript literal
 *   layer 2  the shell command the payload is written with
 *
 * — and each layer fails on a different class of content. This measures which
 * routes survive which payloads, so the recovery guidance names a strategy that
 * is actually known to work rather than another cosmetic re-quote.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BS = String.fromCharCode(92)

const PAYLOADS = {
  mixedQuotes: `print("it's fine")`,
  backslashes: `pattern = re.compile(r"${BS}d+${BS}s*")  # path: C:${BS}Users${BS}x`,
  templateMarkers: 'const t = `${a.b}` // backtick + ${...}',
  tripleQuoted: `def f():\n    """doc\n    'single' "double"\n    """\n    return 1`,
  unicode: 'label = "中文 · μ ± σ"',
  heredocLookalike: 'x = 1\nEOF\ny = 2',
  shellExpansions: 'echo $HOME $(whoami) `date` ${VAR:-default}',
}

/** Embed a payload into a Code Mode style JS call, one strategy per row. */
const JS_EMBEDDING = {
  singleQuote: value => `'${value}'`,
  doubleQuote: value => `"${value}"`,
  templateLiteral: value => `\`${value}\``,
  jsonEscaped: value => JSON.stringify(value),
}

/** Whether a generated Code Mode call is syntactically valid JavaScript. */
function parses(source) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`(async () => { await bash({ command: ${source} }) })`)
    return true
  } catch {
    return false
  }
}

test('naive JS embedding is the transport failure: it breaks on ordinary research payloads', () => {
  const survives = {}
  for (const [strategy, embed] of Object.entries(JS_EMBEDDING)) {
    survives[strategy] = Object.values(PAYLOADS).filter(payload => parses(embed(payload))).length
  }
  const total = Object.keys(PAYLOADS).length

  // Every naive quoting strategy loses payloads; re-quoting cycles between
  // them, which is why the same parser error repeats.
  assert.ok(survives.singleQuote < total, 'single quotes should fail on some payloads')
  assert.ok(survives.doubleQuote < total, 'double quotes should fail on some payloads')
  assert.ok(survives.templateLiteral < total, 'template literals should fail on ${...} and backticks')

  // Correct escaping is not a matter of luck: it survives all of them.
  assert.equal(survives.jsonEscaped, total, 'JSON-escaped literals must survive every payload')

  // The specific trap: a template literal is the natural choice for multiline
  // payloads and is exactly what `${...}` and backticks break.
  assert.equal(parses(JS_EMBEDDING.templateLiteral(PAYLOADS.templateMarkers)), false)
  assert.equal(parses(JS_EMBEDDING.jsonEscaped(PAYLOADS.templateMarkers)), true)
})

const BASH = 'C:/Program Files/Git/bin/bash.exe'
const canRunShell = process.platform === 'win32' && existsSync(BASH)

function runShell(command, cwd) {
  return spawnSync(BASH, ['-c', command], { cwd, encoding: 'utf8' })
}

test('the shell layer fails independently, and base64 is the route that survives both', { skip: !canRunShell }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-transport-')).split(BS).join('/')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const results = { heredoc: 0, base64: 0 }
  const total = Object.keys(PAYLOADS).length

  for (const [name, payload] of Object.entries(PAYLOADS)) {
    // Route A: quoted heredoc — safe for shell metacharacters, but the
    // delimiter is content-dependent.
    const heredocTarget = `${dir}/${name}.heredoc.txt`
    runShell(`cat > '${heredocTarget}' <<'EOF'\n${payload}\nEOF`, dir)
    const heredocOk = existsSync(heredocTarget) && readFileSync(heredocTarget, 'utf8').replace(/\r\n/g, '\n').trimEnd() === payload.trimEnd()
    if (heredocOk) results.heredoc += 1

    // Route B: base64 — the encoded form is plain alphanumerics, so neither
    // the JS layer nor the shell layer can misparse it.
    const b64Target = `${dir}/${name}.b64.txt`
    const encoded = Buffer.from(payload, 'utf8').toString('base64')
    runShell(`printf %s '${encoded}' | base64 -d > '${b64Target}'`, dir)
    const b64Ok = existsSync(b64Target) && readFileSync(b64Target, 'utf8') === payload
    if (b64Ok) results.base64 += 1

    // The encoded command text is always safe in BOTH layers.
    assert.ok(parses(JS_EMBEDDING.jsonEscaped(`printf %s '${encoded}' | base64 -d > out`)))
    assert.match(encoded, /^[A-Za-z0-9+/=]*$/)
  }

  // A heredoc loses any payload containing its own delimiter — the failure a
  // second re-quote cannot fix.
  assert.ok(results.heredoc < total, 'heredoc should lose the delimiter-collision payload')
  assert.equal(results.base64, total, 'base64 must round-trip every payload byte-for-byte')
})

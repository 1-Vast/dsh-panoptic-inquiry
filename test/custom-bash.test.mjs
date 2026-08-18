import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../preset/deep-performance/custom-bash.mjs'

function mounted(outcome, streams = { stdout: '', stderr: '' }) {
  const calls = []
  const tools = []
  apply({
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn(options) {
        calls.push(options)
        return {
          done: Promise.resolve(outcome),
          collected: {
            stdout: { readFrom: () => ({ text: streams.stdout }) },
            stderr: { readFrom: () => ({ text: streams.stderr }) },
          },
        }
      },
    },
    tools: { register(tool) { tools.push(tool) } },
  }, { bashPath: 'bash', timeoutMs: 300000 })
  return { tool: tools[0], calls }
}

test('an expected non-zero exit is a result to read, not a tool error', async () => {
  // grep 1 = no match. Raising here made the caller re-plan around an
  // exception instead of reading the outcome.
  const { tool } = mounted({ exitCode: 1 }, { stdout: '', stderr: '' })
  assert.deepEqual(await tool.execute({ command: 'grep -r missing .' }, {}), { text: 'exit code: 1\n(no output)' })

  const pytest = mounted({ exitCode: 5 }, { stdout: 'no tests ran', stderr: '' })
  const result = await pytest.tool.execute({ command: 'pytest' }, {})
  assert.match(result.text, /^exit code: 5/)
  assert.match(result.text, /no tests ran/)
})

test('a command terminated without an exit code stays an execution failure', async () => {
  const { tool } = mounted({ exitCode: null }, { stdout: '', stderr: '' })
  await assert.rejects(tool.execute({ command: 'sleep 999' }, {}), /terminated without an exit code/)

  const cancelled = mounted({ exitCode: null }, { stdout: 'partial', stderr: '' })
  await assert.rejects(
    cancelled.tool.execute({ command: 'sleep 999' }, { signal: { aborted: true } }),
    /cancelled/,
  )
})

test('the description tells the caller that a non-zero exit is a result', () => {
  const { tool } = mounted({ exitCode: 0 })
  assert.match(tool.description, /non-zero exit is returned as a normal result/)
  assert.match(tool.description, /grep 1 = no match/)
})

test('a successful command returns its merged output', async () => {
  const { tool } = mounted({ exitCode: 0 }, { stdout: 'ok', stderr: 'warn' })
  assert.deepEqual(await tool.execute({ command: 'true' }, {}), { text: 'ok\nwarn' })
})

test('the description sends long work to bash_job instead of shell backgrounding', () => {
  const { tool } = mounted({ exitCode: 0 })
  assert.match(tool.description, /Backgrounding with `&` does NOT return control/)
  assert.match(tool.description, /bash_job/)
})

test('output stays capped and stdin is never inherited', async () => {
  const { tool, calls } = mounted({ exitCode: 0 }, { stdout: 'ok', stderr: '' })
  await tool.execute({ command: 'echo ok', workdir: 'D:\\work' }, {})
  assert.equal(calls[0].stdio.stdin, 'ignore')
  assert.ok(calls[0].stdio.stdout.maxBytes > 0)
  assert.ok(calls[0].stdio.stderr.maxBytes > 0)
  assert.equal(calls[0].cwd, 'D:\\work')
})

test('an identical repeated failure is flagged in-band as no progress', async () => {
  const session = { id: 's1' }
  const exec = { agent: { session } }
  const { tool } = mounted({ exitCode: 1 }, { stdout: 'ModuleNotFoundError: no module named x', stderr: '' })

  const first = await tool.execute({ command: 'python run.py' }, exec)
  assert.doesNotMatch(first.text, /no progress/)

  const second = await tool.execute({ command: 'python run.py' }, exec)
  assert.match(second.text, /no progress: identical failure 2x/)
  assert.match(second.text, /Change the strategy/)

  // A different command in the same session is not a repeat.
  const other = await tool.execute({ command: 'python other.py' }, exec)
  assert.doesNotMatch(other.text, /no progress/)

  // A different session does not inherit another session's history.
  const fresh = await tool.execute({ command: 'python run.py' }, { agent: { session: { id: 's2' } } })
  assert.doesNotMatch(fresh.text, /no progress/)
})

test('repeated success is never flagged', async () => {
  const exec = { agent: { session: { id: 's3' } } }
  const { tool } = mounted({ exitCode: 0 }, { stdout: 'ok', stderr: '' })
  await tool.execute({ command: 'git status' }, exec)
  const second = await tool.execute({ command: 'git status' }, exec)
  assert.doesNotMatch(second.text, /no progress/)
})

test('only infrastructure failures raise: expected non-zero results stay results', async () => {
  // Fixture of outcomes a repair loop actually produces. Under the previous
  // rule (any non-zero exit throws) every one of these but the first became a
  // ToolCallError the caller had to re-plan around.
  const fixture = [
    { label: 'success', outcome: { exitCode: 0 }, raises: false },
    { label: 'grep no match', outcome: { exitCode: 1 }, raises: false },
    { label: 'diff differs', outcome: { exitCode: 1 }, raises: false },
    { label: 'pytest nothing collected', outcome: { exitCode: 5 }, raises: false },
    { label: 'real test failure', outcome: { exitCode: 1 }, raises: false },
    { label: 'command not found', outcome: { exitCode: 127 }, raises: false },
    { label: 'killed without an exit code', outcome: { exitCode: null }, raises: true },
  ]
  let raised = 0
  for (const item of fixture) {
    const { tool } = mounted(item.outcome, { stdout: item.label, stderr: '' })
    try {
      const result = await tool.execute({ command: item.label }, {})
      assert.equal(item.raises, false, `${item.label} should have raised`)
      if (item.outcome.exitCode !== 0) assert.match(result.text, /^exit code: \d+/)
    } catch {
      raised += 1
      assert.equal(item.raises, true, `${item.label} should not have raised`)
    }
  }
  // 6 of 7 outcomes previously surfaced as tool errors; only the lifecycle
  // failure does now.
  assert.equal(raised, 1)
})

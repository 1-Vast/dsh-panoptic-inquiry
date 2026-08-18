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

test('a failing command keeps its exit code alongside its output', async () => {
  const { tool } = mounted({ exitCode: 5 }, { stdout: 'no tests ran', stderr: '' })
  await assert.rejects(tool.execute({ command: 'pytest' }, {}), /no tests ran\n\(exit code: 5\)/)
})

test('a command terminated without a numeric code says so instead of printing a null code', async () => {
  const { tool } = mounted({ exitCode: null }, { stdout: '', stderr: '' })
  await assert.rejects(tool.execute({ command: 'sleep 999' }, {}), /exit code: unknown \(terminated\)/)
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

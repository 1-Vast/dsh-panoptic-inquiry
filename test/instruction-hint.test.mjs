import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../preset/deep-performance/instruction-hint.mjs'

test('injects one instruction hint per compaction epoch', async () => {
  const listeners = {}
  const ctx = {
    on(name, callback) { listeners[name] = callback },
    get(name) {
      if (name !== 'fs') return undefined
      return {
        async resolve(path) { return path },
        async stat(path) {
          if (path === 'D:\\work\\.git') return { type: 'directory' }
          if (path === 'D:\\work\\AGENTS.md') return { type: 'file' }
          return undefined
        },
      }
    },
    logger: { warn() {} },
  }
  apply(ctx, { promoteOn: 'either' })

  const session = {
    id: 'session-1',
    header: { cwd: 'D:\\work', delegationDepth: 0 },
    events: [{ type: 'tool/call', seq: 0, data: {} }],
  }
  const agent = { session }
  const next = async () => ({ kind: 'enter', messages: [] })

  const first = await listeners['agent/pre-step']({ agent }, next)
  assert.equal(first.messages.length, 1)
  assert.match(first.messages[0].content[0].text, /AGENTS\.md/)

  const repeated = await listeners['agent/pre-step']({ agent }, next)
  assert.equal(repeated.messages.length, 0)

  const compacted = { type: 'compaction/end', seq: 1, data: {} }
  session.events.push(compacted)
  listeners['session/event'](session, compacted)
  const promoted = { type: 'assistant/message', seq: 2, data: {} }
  session.events.push(promoted)
  listeners['session/event'](session, promoted)

  const nextEpoch = await listeners['agent/pre-step']({ agent }, next)
  assert.equal(nextEpoch.messages.length, 1)
})

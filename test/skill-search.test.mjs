import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../preset/deep-performance/skill-search.mjs'

function mounted(definitions) {
  const tools = []
  const ctx = {
    tools: { register(tool) { tools.push(tool) } },
    skills: {
      async list() { return definitions.map(({ content: _content, ...summary }) => summary) },
      async get(name) { return definitions.find(skill => skill.name === name) },
    },
  }
  apply(ctx)
  return Object.fromEntries(tools.map(tool => [tool.name, tool]))
}

const allowed = {
  name: 'paper-reader',
  description: '\u8bba\u6587\u4e0e\u6587\u6863\u5904\u7406',
  provider: 'test',
  resourceBase: { kind: 'directory', path: 'D:\\skills\\paper-reader' },
  invocation: { modelInvocable: true, userInvocable: true },
  content: 'Read the paper carefully.',
}

const blocked = {
  name: 'human-only',
  description: '\u4ec5\u4f9b\u7528\u6237\u8c03\u7528',
  provider: 'test',
  invocation: { modelInvocable: false, userInvocable: true },
  content: 'Secret instructions.',
}

test('search supports Chinese terms and hides non-model-invocable skills', async () => {
  const tools = mounted([allowed, blocked])
  const result = await tools.skill_search.execute({ query: '\u6587\u6863' }, {})
  assert.match(result.text, /paper-reader/)
  assert.doesNotMatch(result.text, /human-only/)
})

test('load enforces model invocation and uses canonical skill rendering', async () => {
  const tools = mounted([allowed, blocked])
  const injections = []
  const agent = {
    session: { header: { cwd: 'D:\\work' } },
    inject(message) { injections.push(message) },
  }

  const denied = await tools.skill_load.execute({ name: 'human-only' }, { agent })
  assert.match(denied.text, /not available for model invocation/)
  assert.equal(injections.length, 0)

  await tools.skill_load.execute({ name: 'paper-reader' }, { agent })
  assert.equal(injections.length, 1)
  assert.match(injections[0].content[0].text, /<skill_content name="paper-reader">/)
  assert.match(injections[0].content[0].text, /D:\\skills\\paper-reader/)
})

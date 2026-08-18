import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, shouldFastTrack } from '../preset/deep-performance/tool-bootstrap.mjs'

function session(content, delegationDepth = 0, source = { kind: 'user' }) {
  return {
    header: { delegationDepth },
    events: [{ type: 'user/message', data: { content, source } }],
  }
}

test('fast-tracks every routed deep lane', () => {
  for (const name of [
    'research-thinking:reasoning',
    'research-thinking:core',
    'research-thinking:innovation-transfer',
    'research-thinking:verification-audit',
  ]) {
    assert.equal(shouldFastTrack(session('request'), [{ name }]), true)
  }
})

test('keeps ordinary root work on the minimal bootstrap', () => {
  assert.equal(shouldFastTrack(session('\u4fee\u590d\u4e00\u4e2a\u666e\u901a\u9519\u8bef')), false)
})

test('fast-tracks delegated agents on their first request', () => {
  assert.equal(shouldFastTrack(session('\u67e5\u627e\u76f8\u5173\u8bba\u6587', 1)), true)
})

test('does not fast-track a root session without a deep route section', () => {
  assert.equal(shouldFastTrack(session('deep research')), false)
})

async function assemble(content, delegationDepth = 0, routeSection) {
  const listeners = {}
  const presentations = []
  apply({
    on(name, callback) { listeners[name] = callback },
  }, {
    shellTools: ['bash'],
    commonTools: ['str_replace_editor'],
    messageSources: ['user'],
    anchorGate: true,
    maxBootstrapSteps: 4,
    promoteAfterFirstResponse: true,
    promotedPresentation: 'code',
  })
  const current = session(content, delegationDepth)
  current.header.cwd = 'D:\\work'
  const agent = {
    session: current,
    ctx: { tools: { presentAs(value) { presentations.push(value) } } },
  }
  const full = {
    tools: [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'web_search' }],
    contexts: [{ kind: 'runtime' }],
    sections: [
      { name: 'deployment:persona', text: 'persona' },
      { name: 'tool:web', text: 'web' },
      ...(routeSection === undefined ? [] : [{ name: routeSection, text: 'route' }]),
    ],
  }
  const assembly = await listeners['system-prompt/assemble']({}, { agent }, async () => full)
  return { assembly, presentations }
}

test('keeps the ordinary first assembly minimal', async () => {
  const { assembly, presentations } = await assemble('\u4fee\u590d\u4e00\u4e2a\u666e\u901a\u9519\u8bef')
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['bash', 'str_replace_editor'])
  assert.deepEqual(assembly.contexts, [])
  assert.deepEqual(assembly.sections.map(section => section.name), ['deployment:persona'])
  assert.deepEqual(presentations, [])
})

test('gives deep research and delegated agents the full code-mode surface immediately', async () => {
  for (const [content, depth, route] of [
    ['\u521b\u65b0\u673a\u5236\u8bbe\u8ba1', 0, 'research-thinking:innovation-transfer'],
    ['\u67e5\u627e\u8bba\u6587', 1, undefined],
  ]) {
    const { assembly, presentations } = await assemble(content, depth, route)
    assert.deepEqual(assembly.tools.map(tool => tool.name), ['bash', 'str_replace_editor', 'web_search'])
    assert.deepEqual(assembly.contexts, [{ kind: 'runtime' }])
    assert.deepEqual(assembly.sections.map(section => section.name), [
      'deployment:persona',
      'tool:web',
      ...(route === undefined ? [] : [route]),
    ])
    assert.deepEqual(presentations, ['code'])
  }
})

test('the execution lane does not bypass the minimal anchor', () => {
  // Execution discipline is for ordinary engineering work, which is exactly
  // what the anchor exists to shape: it must not fast-track promotion.
  assert.equal(shouldFastTrack(session('why is this test failing?'), [{ name: 'research-thinking:execution' }]), false)
})

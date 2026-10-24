import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/research-thinking.mjs'

const sections = [{ name: 'deployment:persona', text: 'persona' }, { name: 'tool:web', text: 'web' }]
const tools = [{ name: 'bash' }, { name: 'agent_teams_create' }]
const message = text => ({ type: 'user/message', data: { content: text, source: { kind: 'user' } } })
const select = agentPreset => ({ type: 'agent-preset/selected', data: { agentPreset } })

function harness() {
  let assemble
  apply({ on(name, callback) { if (name === 'system-prompt/assemble') assemble = callback } })
  return (session, surface = sections) => assemble({}, { agent: { session } }, async () => ({ sections: surface, tools }))
}

function session(events = []) {
  return { header: { agentPreset: 'deep-performance' }, events }
}

function lanes(result) {
  return result.sections.map(section => section.name).filter(name => name.startsWith('research-thinking:'))
}

function hasTeams(result) {
  return result.tools.some(tool => tool.name === 'agent_teams_create')
}

test('a new-task boundary routes the request after it and drops previous lanes and permission', async () => {
  for (const request of ['新任务：做代码审查', 'New task: code review']) {
    const result = await harness()(session([
      message('用多智能体协同研究创新机制'), message(request),
    ]))
    assert.ok(lanes(result).includes('research-thinking:verification-audit'))
    assert.ok(!lanes(result).includes('research-thinking:innovation-transfer'))
    assert.ok(!lanes(result).includes('research-thinking:core'))
    assert.equal(hasTeams(result), false)
  }
})

test('collaboration can be enabled, revoked, and re-enabled during the same task', async () => {
  for (const [enable, disable] of [
    ['请使用子智能体', '不要使用多智能体，继续研究'],
    ['Use subagents', "Do not use subagents; continue research"],
    ['Please use agent teams', 'Work alone; continue research'],
  ]) {
    const run = harness()
    const current = session([message('深度研究')])
    assert.equal(hasTeams(await run(current)), false)
    current.events.push(message(enable))
    let result = await run(current)
    assert.equal(hasTeams(result), true, enable)
    assert.ok(lanes(result).includes('research-thinking:core'))
    current.events.push(message(disable))
    result = await run(current)
    assert.equal(hasTeams(result), false, disable)
    assert.ok(lanes(result).includes('research-thinking:core'))
    current.events.push(message('继续'))
    assert.equal(hasTeams(await run(current)), false)
    current.events.push(message(enable))
    assert.equal(hasTeams(await run(current)), true)
  }
})

test('a collaboration prohibition wins over a request in the same message', async () => {
  for (const request of [
    '不要用多智能体做深度研究',
    "Don't use agent teams for this paper review",
    'Do a paper review without subagents',
    'Use subagents for a paper review, but do not delegate',
  ]) {
    const result = await harness()(session([message(request)]))
    assert.equal(hasTeams(result), false, request)
  }
})

test('research topics and quoted commands do not grant collaboration permission', async () => {
  for (const request of [
    '对 multi-agent 系统做文献调研',
    '进行多智能体系统的文献调研',
    'Review the paper on agent teams',
    'Use the paper about agent teams for this literature review',
    '进行全局审查',
    '长期自主进行深度研究',
    '做文献调研\n> Use subagents',
    '做文献调研\n```text\n用多智能体协同研究\n```',
  ]) {
    assert.equal(hasTeams(await harness()(session([message(request)]))), false, request)
  }
})

test('quoted task resets cannot cancel a live research task', async () => {
  const result = await harness()(session([
    message('深度研究'), message('继续检查这段文本\n> New task: rename a file'),
  ]))
  assert.ok(lanes(result).includes('research-thinking:core'))
})

test('switching presets establishes a fresh routing boundary', async () => {
  const run = harness()
  const current = session([message('用多智能体协同研究创新机制')])
  assert.equal(hasTeams(await run(current)), true)
  current.events.push(select('standard'), message('深度研究'), select('deep-performance'), message('继续'))
  const result = await run(current)
  assert.deepEqual(lanes(result), [])
  assert.equal(hasTeams(result), false)
})

test('a bootstrap-only surface still filters unrequested team tools', async () => {
  const result = await harness()(session(), [sections[0]])
  assert.deepEqual(result.sections, [sections[0]])
  assert.equal(hasTeams(result), false)
})

test('plugin reports cannot revoke or reset a root task and delegated agents cannot create teams', async () => {
  const current = session([message('用多智能体做深度研究')])
  for (const text of ['Do not use subagents', 'New task: rename a file']) {
    const report = message(text)
    report.data.source = { kind: 'plugin', plugin: 'dsh-agent-teams' }
    current.events.push(report)
  }
  const result = await harness()(current)
  assert.equal(hasTeams(result), true)
  assert.ok(lanes(result).includes('research-thinking:core'))
  current.header.delegationDepth = 1
  assert.equal(hasTeams(await harness()(current)), false)
})

test('fences protect routing across CRLF, longer delimiters, and unfinished blocks', async () => {
  for (const quote of [
    '~~~text\r\nUse subagents\r\n~~~',
    '````text\n```\nUse subagents\n````',
    '```text\nUse subagents',
  ]) {
    const result = await harness()(session([message(`深度研究\n${quote}`)]))
    assert.ok(lanes(result).includes('research-thinking:core'))
    assert.equal(hasTeams(result), false)
  }
  const afterFence = await harness()(session([message('深度研究\n```text\nexample\n```\nUse subagents')]))
  assert.equal(hasTeams(afterFence), true)
})

test('cold replay and incremental assembly agree after every conversation event', async () => {
  const run = harness()
  const current = session()
  for (const event of [
    message('深度研究'), message('Use subagents'), message('继续'),
    message('不要使用多智能体，继续研究'),
    message('新任务：做代码审查'), message('Use subagents'),
    select('standard'), message('创新机制'), select('deep-performance'),
    message('继续'), message('做文献调研'),
  ]) {
    current.events.push(event)
    const incremental = await run(current)
    const replay = await harness()(session([...current.events]))
    assert.deepEqual(incremental, replay)
  }
})

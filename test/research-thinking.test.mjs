import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/research-thinking.mjs'

const baseSections = [
  { name: 'deployment:persona', text: 'persona' },
  { name: 'tool:web', text: 'web' },
]

function message(text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { content: text, source } }
}

function assembleFor(agentPreset, sections, events = [], header = {}) {
  let listener
  apply({ on(name, callback) { if (name === 'system-prompt/assemble') listener = callback } })
  const session = { header: { agentPreset, ...header }, events }
  return listener({}, { agent: { session } }, async () => ({ sections }))
}

function sectionNames(result) {
  return result.sections.map(item => item.name)
}

test('does not alter the preset bootstrap assembly', async () => {
  const result = await assembleFor('deep-performance', [{ name: 'deployment:persona', text: 'persona' }])
  assert.deepEqual(sectionNames(result), ['deployment:persona'])
})

test('adds no mode prompt overhead to ordinary work', async () => {
  const result = await assembleFor('deep-performance', [
    ...baseSections,
    { name: 'agent-teams:usage', text: 'poll forever' },
  ], [message('\u628a\u65e5\u5fd7\u7ea7\u522b\u6539\u6210 debug')])
  assert.deepEqual(sectionNames(result), ['deployment:persona', 'tool:web'])
})

test('exposes AgentTeams only when deep work explicitly needs collaboration', async () => {
  const tools = [{ name: 'bash' }, { name: 'agent_teams_create' }, { name: 'agent_teams_status' }]
  let listener
  apply({ on(name, callback) { if (name === 'system-prompt/assemble') listener = callback } })

  const ordinary = await listener({}, {
    agent: { session: { header: { agentPreset: 'deep-performance' }, events: [message('\u4fee\u590d\u666e\u901a\u9519\u8bef')] } },
  }, async () => ({ sections: baseSections, tools }))
  assert.deepEqual(ordinary.tools.map(tool => tool.name), ['bash'])

  const deep = await listener({}, {
    agent: { session: { header: { agentPreset: 'deep-performance' }, events: [message('\u6df1\u5ea6\u7814\u7a76')] } },
  }, async () => ({ sections: baseSections, tools }))
  assert.deepEqual(deep.tools.map(tool => tool.name), ['bash'])

  const collaborative = await listener({}, {
    agent: { session: { header: { agentPreset: 'deep-performance' }, events: [message('\u8fdb\u884c\u591a\u667a\u80fd\u4f53\u534f\u540c\u6df1\u5ea6\u7814\u7a76')] } },
  }, async () => ({ sections: baseSections, tools }))
  assert.deepEqual(collaborative.tools.map(tool => tool.name), ['bash', 'agent_teams_create', 'agent_teams_status'])
})

test('enables core evidence rules for literature work', async () => {
  const result = await assembleFor('deep-performance', baseSections, [message('\u8bf7\u8fdb\u884c\u6df1\u5ea6\u7814\u7a76\u548c\u6587\u732e\u8c03\u7814')])
  const names = sectionNames(result)
  assert.ok(names.includes('research-thinking:core'))
  assert.ok(!names.includes('research-thinking:innovation-transfer'))
  assert.match(result.sections.find(item => item.name === 'research-thinking:core').text, /preprints are provisional leads only/)
  assert.match(result.sections.find(item => item.name === 'research-thinking:core').text, /reputable specialist journals/)
})

test('enables all gates for innovation work', async () => {
  const result = await assembleFor('deep-performance', baseSections, [message('\u63d0\u51fa\u8de8\u9886\u57df\u521b\u65b0\u673a\u5236\u548c\u5b9e\u9a8c\u8bbe\u8ba1')])
  const names = sectionNames(result)
  assert.ok(names.includes('research-thinking:core'))
  assert.ok(names.includes('research-thinking:innovation-transfer'))
  assert.ok(names.includes('research-thinking:verification-audit'))
  assert.match(result.sections.find(item => item.name === 'research-thinking:innovation-transfer').text, /Reject renamed components/)
  assert.match(result.sections.find(item => item.name === 'research-thinking:verification-audit').text, /Leakage and contamination/)
})

test('enables evidence and verification for paper review and reproduction', async () => {
  for (const request of ['\u8bf7\u4e25\u683c\u8bc4\u5ba1\u8fd9\u7bc7\u8bba\u6587', '\u8bf7\u505a\u5b9e\u9a8c\u590d\u73b0\u3001\u6570\u636e\u6cc4\u9732\u548c\u6d88\u878d\u5ba1\u67e5']) {
    const result = await assembleFor('deep-performance', baseSections, [message(request)])
    const names = sectionNames(result)
    assert.ok(names.includes('research-thinking:core'))
    assert.ok(names.includes('research-thinking:verification-audit'))
  }
})

test('requires scoped and complete evidence before a goal is marked complete', async () => {
  const result = await assembleFor('deep-performance', baseSections, [message('\u8bf7\u505a\u79d1\u7814\u5ba1\u67e5\u5e76\u7ed9\u51fa\u6700\u7ec8\u7ed3\u8bba')])
  const audit = result.sections.find(item => item.name === 'research-thinking:verification-audit').text
  assert.match(audit, /physical split isolation/)
  assert.match(audit, /clean worktree/)
  assert.match(audit, /after the last stage/)
  assert.match(audit, /proxy tests/)
  assert.match(audit, /not an information-theoretic upper bound/)
  assert.match(audit, /conditional completion/)
})

async function injectedChars(request) {
  const result = await assembleFor('deep-performance', baseSections, [message(request)])
  return result.sections
    .filter(item => item.name.startsWith('research-thinking:'))
    .reduce((sum, item) => sum + item.text.length, 0)
}

test('spends prompt budget in proportion to the depth the task needs', async () => {
  // Ordinary work carries no protocol at all; each lane pays only for itself.
  assert.equal(await injectedChars('\u628a\u65e5\u5fd7\u7ea7\u522b\u6539\u6210 debug'), 0)
  assert.ok(await injectedChars('why is this unit test failing?') <= 2200)
  assert.ok(await injectedChars('Why does this architecture fail to transfer?') <= 5400)
  assert.ok(await injectedChars('\u505a\u5de5\u7a0b\u5ba1\u67e5') <= 6200)
  assert.ok(await injectedChars('\u8fdb\u884c\u591a\u667a\u80fd\u4f53\u534f\u540c\u7684\u8de8\u9886\u57df\u521b\u65b0\u673a\u5236\u5ba1\u67e5') <= 11500)
})

test('routes semantically deep questions that never name a mode', async () => {
  const requests = [
    'Why does this architecture fail to transfer?',
    'Is the model learning biology or dataset bias?',
    'What experiment would distinguish these explanations?',
    'Can this improvement actually be attributed to the proposed module?',
    'Find the fundamental limitation of this approach.',
    'our model beats the baseline but only on one seed',
    '\u4e3a\u4ec0\u4e48\u8fd9\u4e2a\u6a21\u578b\u5728\u65b0\u6570\u636e\u4e0a\u6ce8\u5b9a\u6cdb\u5316\u4e0d\u4e86\uff1f',
    '\u8fd9\u4e2a\u63d0\u5347\u80fd\u5f52\u56e0\u4e8e\u65b0\u6a21\u5757\u5417\uff1f',
    '\u6307\u6807\u63d0\u5347\u662f\u771f\u5b9e\u6548\u679c\u8fd8\u662f\u968f\u673a\u6ce2\u52a8\uff1f',
  ]
  for (const request of requests) {
    const result = await assembleFor('deep-performance', baseSections, [message(request)])
    assert.ok(
      sectionNames(result).includes('research-thinking:reasoning'),
      `expected the reasoning lane for: ${request}`,
    )
  }
})

test('leaves ordinary engineering work on the fast path', async () => {
  const requests = [
    'fix a typo in the README',
    'rename the variable in train.py',
    'list the files under src',
    'set the log level to debug',
    '\u628a\u65e5\u5fd7\u7ea7\u522b\u6539\u6210 debug',
    'run the linter and commit',
  ]
  for (const request of requests) {
    const result = await assembleFor('deep-performance', baseSections, [message(request)])
    assert.deepEqual(sectionNames(result), ['deployment:persona', 'tool:web'], `unexpected protocol for: ${request}`)
  }
})

test('the reasoning lane demands hypotheses, root cause, and a calibrated verdict', async () => {
  const result = await assembleFor('deep-performance', baseSections, [message('Why does this model fail to generalize?')])
  const reasoning = result.sections.find(item => item.name === 'research-thinking:reasoning').text
  assert.match(reasoning, /two to four competing explanations/)
  assert.match(reasoning, /dominant bottleneck/)
  assert.match(reasoning, /add architectural complexity only once evidence shows architecture is the limit/)
  assert.match(reasoning, /expected information gain/)
  assert.match(reasoning, /preferred explanation is unsupported/)
  assert.match(reasoning, /not identifiable from current evidence/)
})

test('the literature lane stages discovery, contradiction, saturation, and a durable ledger', async () => {
  const result = await assembleFor('deep-performance', baseSections, [message('\u8bf7\u8fdb\u884c\u6df1\u5ea6\u7814\u7a76\u548c\u6587\u732e\u8c03\u7814')])
  const core = result.sections.find(item => item.name === 'research-thinking:core').text
  assert.match(core, /complementary queries as one batch/)
  assert.match(core, /Search for contradiction before any strong claim/)
  assert.match(core, /More references are not more evidence/)
  assert.match(core, /survives compaction/)
})

test('an engineering audit gets verification without literature or reasoning overhead', async () => {
  const result = await assembleFor('deep-performance', baseSections, [message('\u505a\u5de5\u7a0b\u5ba1\u67e5\u548c\u4ee3\u7801\u5ba1\u67e5')])
  const names = sectionNames(result)
  assert.ok(names.includes('research-thinking:verification-audit'))
  assert.ok(!names.includes('research-thinking:core'))
  assert.ok(!names.includes('research-thinking:reasoning'))
})

test('keeps a non-literature lane alive across a short continuation', async () => {
  const result = await assembleFor('deep-performance', baseSections, [
    message('\u505a\u5de5\u7a0b\u5ba1\u67e5'),
    message('\u7ee7\u7eed'),
  ])
  assert.ok(sectionNames(result).includes('research-thinking:verification-audit'))
})

test('fast-tracks a deep request through the bootstrap assembly', async () => {
  const result = await assembleFor('deep-performance', [
    { name: 'deployment:persona', text: 'minimal persona' },
  ], [message('\u8fdb\u884c\u6df1\u5ea6\u7814\u7a76')])
  assert.ok(sectionNames(result).includes('research-thinking:core'))
})

test('enables verification without literature overhead for a GPU engineering audit', async () => {
  const result = await assembleFor('deep-performance', baseSections, [message('\u68c0\u67e5\u6a21\u578b\u8bad\u7ec3\u662f\u5426\u771f\u6b63\u8dd1\u5728GPU\uff0c\u5e76\u505a\u5de5\u7a0b\u5ba1\u67e5')])
  const names = sectionNames(result)
  assert.ok(!names.includes('research-thinking:core'))
  assert.ok(names.includes('research-thinking:verification-audit'))
  assert.match(result.sections.find(item => item.name === 'research-thinking:verification-audit').text, /Hardware availability alone is not evidence/)
})

test('uses the latest selected preset instead of the creation header', async () => {
  const result = await assembleFor('standard', baseSections, [
    { type: 'agent-preset/selected', data: { agentPreset: 'deep-performance' } },
    message('\u521b\u65b0\u673a\u5236\u8bbe\u8ba1'),
  ])
  assert.ok(sectionNames(result).includes('research-thinking:innovation-transfer'))
})

test('stops applying after a later switch away from the research preset', async () => {
  const result = await assembleFor('deep-performance', baseSections, [
    { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
    message('\u521b\u65b0\u673a\u5236\u8bbe\u8ba1'),
  ])
  assert.deepEqual(sectionNames(result), ['deployment:persona', 'tool:web'])
})

test('keeps research active across a human refinement', async () => {
  const result = await assembleFor('deep-performance', baseSections, [
    message('\u8fdb\u884c\u6df1\u5ea6\u7814\u7a76'),
    message('\u91cd\u70b9\u770b\u8ba1\u7b97\u673a\u89c6\u89c9\u65b9\u5411'),
  ])
  assert.ok(sectionNames(result).includes('research-thinking:core'))
})

test('keeps research active across a short continuation', async () => {
  const result = await assembleFor('deep-performance', baseSections, [
    message('\u8fdb\u884c\u6df1\u5ea6\u7814\u7a76'),
    message('\u7ee7\u7eed'),
  ])
  assert.ok(sectionNames(result).includes('research-thinking:core'))
})

test('ignores AgentTeams reports and skill injections in the root session', async () => {
  const result = await assembleFor('deep-performance', baseSections, [
    message('\u8fdb\u884c\u6df1\u5ea6\u7814\u7a76'),
    message('AgentTeams report', { kind: 'plugin', plugin: 'dsh-agent-teams' }),
    message('loaded skill', { kind: 'skill-invocation', name: 'paper-review' }),
  ])
  assert.ok(sectionNames(result).includes('research-thinking:core'))
})

test('accepts a research task packet from AgentTeams only in a delegated session', async () => {
  const result = await assembleFor('deep-performance', baseSections, [
    message('Review reproducibility and data leakage', { kind: 'plugin', plugin: 'dsh-agent-teams' }),
  ], { delegationDepth: 1 })
  assert.ok(sectionNames(result).includes('research-thinking:verification-audit'))

  const root = await assembleFor('deep-performance', baseSections, [
    message('Review reproducibility and data leakage', { kind: 'plugin', plugin: 'dsh-agent-teams' }),
  ])
  assert.deepEqual(sectionNames(root), ['deployment:persona', 'tool:web'])
})

test('clears research state on an unrelated new task or explicit exit', async () => {
  for (const followup of ['\u65b0\u4efb\u52a1\uff1a\u5b89\u88c5\u4e00\u4e2a\u63d2\u4ef6', '\u9000\u51fa\u6df1\u7814\uff0c\u56de\u5230\u666e\u901a\u6a21\u5f0f']) {
    const result = await assembleFor('deep-performance', baseSections, [
      message('\u8fdb\u884c\u6df1\u5ea6\u7814\u7a76'),
      message(followup),
    ])
    assert.deepEqual(sectionNames(result), ['deployment:persona', 'tool:web'])
  }
})

test('does not affect other presets', async () => {
  const result = await assembleFor('standard', baseSections, [message('\u6df1\u5ea6\u7814\u7a76')])
  assert.deepEqual(sectionNames(result), ['deployment:persona', 'tool:web'])
})

test('reserves AgentTeams for asked-for collaboration, not for training vocabulary', async () => {
  const tools = [{ name: 'bash' }, { name: 'agent_teams_create' }]
  let listener
  apply({ on(name, callback) { if (name === 'system-prompt/assemble') listener = callback } })
  const assemble = (text) => listener({}, {
    agent: { session: { header: { agentPreset: 'deep-performance' }, events: [message(text)] } },
  }, async () => ({ sections: baseSections, tools }))

  const tensorParallel = await assemble('分析张量并行训练为什么不收敛')
  assert.deepEqual(tensorParallel.tools.map(tool => tool.name), ['bash'])
  assert.ok(!sectionNames(tensorParallel).includes('research-thinking:collaboration'))

  const collaborative = await assemble('用多智能体协同做深度研究')
  assert.deepEqual(collaborative.tools.map(tool => tool.name), ['bash', 'agent_teams_create'])
  const contract = collaborative.sections.find(item => item.name === 'research-thinking:collaboration').text
  assert.match(contract, /independent in execution/)
  assert.match(contract, /claim, evidence with stable sources, contradiction found, uncertainty/)
  assert.match(contract, /break the conclusion/)
})

test('routes long work to the durable job tool only when the session actually has it', async () => {
  let listener
  apply({ on(name, callback) { if (name === 'system-prompt/assemble') listener = callback } })
  const assemble = (tools) => listener({}, {
    agent: { session: { header: { agentPreset: 'deep-performance' }, events: [message('请进行深度研究')] } },
  }, async () => ({ sections: baseSections, tools }))

  const withJobs = await assemble([{ name: 'bash' }, { name: 'bash_job' }])
  assert.match(withJobs.sections.find(item => item.name === 'research-thinking:router').text, /bash_job/)

  const withoutJobs = await assemble([{ name: 'bash' }])
  const router = withoutJobs.sections.find(item => item.name === 'research-thinking:router').text
  assert.doesNotMatch(router, /bash_job/)
  assert.match(router, /detached work with a log and a recorded pid/)
})

test('gives failure-shaped and implementation work an execution lane, without research overhead', async () => {
  for (const request of [
    'why is this unit test failing?',
    'why does the build fail on Windows?',
    'the parser crashes on empty input',
    'implement retry logic for the uploader',
    '重构这个模块并修复报错',
    'help me debug the parser',
  ]) {
    const names = sectionNames(await assembleFor('deep-performance', baseSections, [message(request)]))
    assert.ok(names.includes('research-thinking:execution'), `expected the execution lane for: ${request}`)
    assert.ok(!names.includes('research-thinking:core'), `unexpected literature lane for: ${request}`)
    assert.ok(!names.includes('research-thinking:verification-audit'), `unexpected audit lane for: ${request}`)
  }
})

test('the execution lane names each failure class and its recovery', async () => {
  const result = await assembleFor('deep-performance', baseSections, [message('why is this test failing?')])
  const execution = result.sections.find(item => item.name === 'research-thinking:execution').text

  // micro-loop collapse
  assert.match(execution, /Batch the evidence/)
  assert.match(execution, /one root-cause explanation, apply one coherent set of edits, and verify once/)
  assert.match(execution, /Re-plan when a result contradicts the explanation, not after every observation/)

  // transport failures are not evidence about the target program
  assert.match(execution, /the payload never ran/)
  assert.match(execution, /stop trying quote variants/)
  assert.match(execution, /base64-encoded/)

  // stale-edit recovery is bounded. Without the deterministic mutation tool
  // mounted, the lane still describes the manual recovery.
  assert.match(execution, /A rejected edit: stale or inexact local state/)
  assert.match(execution, /After a second miss change the mutation method/)

  // exit codes are results
  assert.match(execution, /grep 1, diff 1 and pytest 5 are answers/)

  // circuit breaker
  assert.match(execution, /same failure class twice on one target/)
})

test('every deep lane carries the execution discipline with it', async () => {
  for (const request of ['请进行深度研究', '做工程审查', 'Why does this model fail to generalize?']) {
    const names = sectionNames(await assembleFor('deep-performance', baseSections, [message(request)]))
    assert.ok(names.includes('research-thinking:execution'), `expected execution discipline for: ${request}`)
  }
})

test('the execution lane points at the deterministic mutation tool when it is mounted', async () => {
  let listener
  apply({ on(name, callback) { if (name === 'system-prompt/assemble') listener = callback } })
  const assemble = (tools) => listener({}, {
    agent: { session: { header: { agentPreset: 'deep-performance' }, events: [message('why is this test failing?')] } },
  }, async () => ({ sections: baseSections, tools }))

  const withEdit = await assemble([{ name: 'bash' }, { name: 'edit_apply' }])
  const lane = withEdit.sections.find(item => item.name === 'research-thinking:execution').text
  assert.match(lane, /Use edit_apply/)
  assert.match(lane, /resolves line-ending and trailing-whitespace drift itself/)
  assert.match(lane, /returns the current text on a conflict/)
  // The runtime owns the recovery, so the prompt does not also describe it.
  assert.doesNotMatch(lane, /After a second miss change the mutation method/)

  const withoutEdit = await assemble([{ name: 'bash' }])
  const fallback = withoutEdit.sections.find(item => item.name === 'research-thinking:execution').text
  assert.doesNotMatch(fallback, /edit_apply/)
  assert.match(fallback, /base64-encoded and decoded into the file/)
})

test('moving recovery into the runtime did not grow the prompt', async () => {
  // Beta.6 adds capability through tools, not tokens: the execution lane with
  // the deterministic tool mounted must not be larger than without it.
  let listener
  apply({ on(name, callback) { if (name === 'system-prompt/assemble') listener = callback } })
  const laneFor = async (tools) => {
    const result = await listener({}, {
      agent: { session: { header: { agentPreset: 'deep-performance' }, events: [message('why is this test failing?')] } },
    }, async () => ({ sections: baseSections, tools }))
    return result.sections.find(item => item.name === 'research-thinking:execution').text.length
  }
  const withEdit = await laneFor([{ name: 'bash' }, { name: 'edit_apply' }])
  const withoutEdit = await laneFor([{ name: 'bash' }])
  assert.ok(withEdit <= withoutEdit + 80, `lane grew from ${withoutEdit} to ${withEdit}`)
})

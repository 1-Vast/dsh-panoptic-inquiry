import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FAILURE_CLASS,
  classifyProcess,
  clearFailure,
  failureSignature,
  noteFailure,
  normalizeDetail,
  repeatNotice,
  trackFailure,
} from '../preset/deep-performance/failure-signature.mjs'

test('a process outcome is classified, not just labelled failed', () => {
  assert.equal(classifyProcess({ exitCode: 0 }), undefined)
  assert.equal(classifyProcess({ exitCode: 1 }), FAILURE_CLASS.processNonZero)
  assert.equal(classifyProcess({ exitCode: 127 }), FAILURE_CLASS.processNotFound)
  assert.equal(classifyProcess({ exitCode: 126 }), FAILURE_CLASS.processPermission)
  assert.equal(classifyProcess({ exitCode: null }), FAILURE_CLASS.processLifecycle)
  assert.equal(classifyProcess({ exitCode: null, cancelled: true }), undefined)
})

test('text evidence refines a generic non-zero exit', () => {
  assert.equal(
    classifyProcess({ exitCode: 1, output: 'bash: pytest: command not found' }),
    FAILURE_CLASS.processNotFound,
  )
  assert.equal(
    classifyProcess({ exitCode: 1, output: 'open failed: Permission denied' }),
    FAILURE_CLASS.processPermission,
  )
  assert.equal(
    classifyProcess({ exitCode: 1, output: 'AssertionError: expected 3, got 4' }),
    FAILURE_CLASS.processNonZero,
  )
})

test('message variants of one failure collapse, so a moving position is not a new problem', () => {
  const variants = [
    "Expected ';' at position 173",
    'Expected a semicolon',
    'Expected string literal near position 181',
  ]
  const normalized = variants.map(normalizeDetail)
  // Positions and offsets are erased; the wording that remains is what differs.
  assert.equal(normalizeDetail("Expected ';' at position 173"), normalizeDetail("Expected ';' at position 4092"))
  assert.equal(normalizeDetail('failed at 0xdeadbeef'), normalizeDetail('failed at 0x00ff'))
  assert.ok(normalized.every(item => item.length > 0))
})

test('a family is (class, target): the same class on one file is one family', () => {
  const first = failureSignature({ failureClass: FAILURE_CLASS.editConflict, target: 'src/a.py' })
  const second = failureSignature({ failureClass: FAILURE_CLASS.editConflict, target: 'src/a.py' })
  const otherFile = failureSignature({ failureClass: FAILURE_CLASS.editConflict, target: 'src/b.py' })
  const otherClass = failureSignature({ failureClass: FAILURE_CLASS.editAmbiguous, target: 'src/a.py' })
  assert.equal(first, second)
  assert.notEqual(first, otherFile)
  assert.notEqual(first, otherClass)
})

test('the notice is silent once and prescribes a transition twice', () => {
  assert.equal(repeatNotice(1, FAILURE_CLASS.processNonZero), '')
  const second = repeatNotice(2, FAILURE_CLASS.editConflict)
  assert.match(second, /no progress: edit_conflict failed 2x/)
  assert.match(second, /rewrite the whole region or the whole file/)
  assert.match(repeatNotice(2, FAILURE_CLASS.processNotFound), /fix PATH or install it/)
  assert.match(repeatNotice(2, FAILURE_CLASS.processLifecycle), /start it with bash_job/)
})

test('counting is per session and bounded, and a success retires a family', () => {
  const session = {}
  const signature = failureSignature({ failureClass: FAILURE_CLASS.processNonZero, target: 'npm test' })
  assert.equal(noteFailure(session, signature), 1)
  assert.equal(noteFailure(session, signature), 2)
  clearFailure(session, signature)
  assert.equal(noteFailure(session, signature), 1)

  // A different session never inherits another's history.
  assert.equal(noteFailure({}, signature), 1)
  // No session (a tool used outside an agent) never accumulates.
  assert.equal(noteFailure(undefined, signature), 1)
  assert.equal(noteFailure(undefined, signature), 1)
})

test('tracking is conservative: different work never merges into one family', () => {
  const session = {}
  // Multiple seeds are different experiments, not a repeated strategy.
  for (const seed of [1, 2, 3, 4]) {
    const tracked = trackFailure(session, {
      failureClass: FAILURE_CLASS.processNonZero,
      target: `python train.py --seed ${seed}`,
    })
    assert.equal(tracked.count, 1)
    assert.equal(tracked.notice, '')
  }
  // Benchmarks over different inputs likewise stay distinct.
  for (const input of ['a.json', 'b.json']) {
    assert.equal(trackFailure(session, {
      failureClass: FAILURE_CLASS.processNonZero,
      target: `bench --input ${input}`,
    }).count, 1)
  }
  // But the same command failing the same way twice is a loop.
  trackFailure(session, { failureClass: FAILURE_CLASS.processNonZero, target: 'make build' })
  const repeat = trackFailure(session, { failureClass: FAILURE_CLASS.processNonZero, target: 'make build' })
  assert.equal(repeat.count, 2)
  assert.match(repeat.notice, /no progress/)
})

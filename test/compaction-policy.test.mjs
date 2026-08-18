/**
 * Compaction policy invariants.
 *
 * The compaction engine itself is host-owned (`@deepseek-ai/dsh-compaction-basic`)
 * and cannot be executed from this repository, so what is testable here is the
 * POLICY this preset declares. These assertions exist because a real long
 * session produced 223 truncated summaries and 0 successful compactions under
 * a 1536-token cap: the failure was a declared-configuration defect, and this
 * file is what stops it from being reintroduced silently.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = await readFile(join(root, 'preset/deep-performance/agent.cordis.yml'), 'utf8')

const number = (key) => {
  const match = config.match(new RegExp(`${key}:\\s*([0-9.]+)`))
  assert.notEqual(match, null, `${key} must be declared`)
  return Number(match[1])
}

test('the summary budget is not starved relative to what it must represent', () => {
  const maxTokens = number('maxTokens')
  const threshold = number('thresholdRatio')
  const retain = number('retainRatio')

  // Each compaction asks the summariser to represent ~(threshold - retain) x W
  // tokens. At 1536 that was a 37:1 to 72:1 compression and it truncated every
  // time. The floor is the lesson, not the exact number.
  assert.ok(maxTokens >= 4096, `summary cap ${maxTokens} is below the 4096 floor that replaced the truncating 1536`)

  // Guard the other direction too: an unbounded cap stops being a summary and
  // starts re-inflating post-compaction context.
  assert.ok(maxTokens <= 8192, `summary cap ${maxTokens} is large enough to undermine the point of compacting`)
})

test('the policy is internally coherent', () => {
  const threshold = number('thresholdRatio')
  const retain = number('retainRatio')

  // The verbatim tail must be smaller than the trigger, or there is nothing
  // left to summarise and compaction cannot reduce anything.
  assert.ok(retain < threshold, `retainRatio ${retain} must be below thresholdRatio ${threshold}`)
  // Compacting must leave real headroom, otherwise the next request re-triggers
  // immediately — the oscillation that turns one failure into a retry storm.
  assert.ok(threshold - retain >= 0.05, 'threshold and retain are too close to leave post-compaction headroom')
  assert.ok(threshold <= 0.5, 'compaction must run well before the model\'s own pressure point')
})

test('summarisation is routed to a declared cheap model', () => {
  // Summarisation volume is ~1 input token per token of conversation growth,
  // independent of the threshold, so the route matters more than the cadence.
  assert.match(config, /summarizationProvider:\s+deepseek-official/)
  assert.match(config, /summarizationModel:\s+deepseek-v4-flash/)
})

test('context suppression stays configured alongside compaction', () => {
  // The measured context reduction between generations came from pruning and
  // removed injections, NOT from compaction (which never succeeded). Those two
  // mechanisms are independent and both must remain declared.
  const pruneThreshold = number('thresholdChars')
  const head = number('headChars')
  const tail = number('tailChars')
  assert.ok(pruneThreshold > head + tail, 'pruning must actually shrink an over-threshold result')
  assert.ok(tail > 0, 'a pruned result must keep its tail, where failures report themselves')
})

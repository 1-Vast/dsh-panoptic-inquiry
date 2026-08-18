# Changelog

## 0.1.0-beta.6.1 (hotfix)

- `edit_apply` now fails closed when the session has no workspace root.
  Previously a missing root disabled confinement entirely, so exactly the
  sessions without a declared workspace could edit anywhere. Widening scope
  still requires `allowOutsideWorkspace`.
- A commit that does not complete no longer claims the original file is
  unchanged. Staging failures (which cannot have renamed anything) keep that
  claim; a failure in the committing command, which carries the rename, now
  returns `commit_uncertain` and states that disk state is uncertain and the
  file must be re-read. A regression simulates termination after the rename
  and asserts the file really did change.
- Added `read_failure` and `commit_uncertain` to the model-facing status list,
  so the declared contract matches runtime behaviour.
- Removed a tautological assertion in the concurrency regression while keeping
  the digest invariant it was meant to check.

## 0.1.0-beta.6.1

Release hardening. No new capabilities; correctness, concurrency, data
integrity, path safety, and claim calibration.

- Corrected the replay baseline. The previous comparison raised on every
  non-zero exit, which was Beta.4 behaviour, so it overstated the Beta.5 cost
  of `grep no match` and `command not found`. The replay now runs the ACTUAL
  Beta.5 bash tool, extracted from commit a719bef into a test fixture. The
  measured reduction is 19 to 10 execution-induced decision boundaries (47%),
  not the 21 to 10 (52%) previously reported.
- Fixed a data-corruption defect in `edit_apply` found by a new concurrency
  test: the splice read `head` and `tail` from the live target, so a
  concurrent replacement landing between the two reads produced a file that
  was a mixture of two writers. The splice now builds from a private snapshot
  whose digest is checked before use.
- Added stale-write protection that does not depend on the caller. The digest
  observed during this edit's own read is re-checked immediately before the
  rename; a target that changed in between is refused with `stale` and nothing
  is written. `expected_sha256` remains an additional caller-side guard.
- Gave every invocation unique staging files (process, counter and random
  entropy), so concurrent edits of one target cannot share or overwrite each
  other's temporary artifacts. Staging is removed on success and on every
  failure path.
- Fixed non-BMP Unicode corruption. Byte offsets were derived by summing
  per-code-unit lengths, which is wrong across surrogate pairs (emoji,
  `𝛼`, `𐐷`). Character offsets and byte offsets are now derived separately and
  each used where it is correct.
- Confined `edit_apply` to the session workspace by default, with canonical
  containment rather than prefix matching, so `D:\work2` is not treated as
  inside `D:\work`. Symlinks and junctions are not resolved; this is
  documented, not claimed as a sandbox.
- A successful mutation now retires process-failure history for the session,
  so a test rerun after a fix is not misreported as a repeated no-progress
  strategy.
- Preserved the line-ending convention of a replaced span, so editing a CRLF
  file with an LF replacement no longer leaves it mixed.
- Corrected the `nearestCandidate` documentation: it returns the first anchor
  line that still occurs, not a longest matching run.

## 0.1.0-beta.6

- Added `edit_apply`: mutation with a status instead of an exception. It
  resolves the commonest recoverable edit failures itself — CRLF and
  trailing-whitespace drift when the match is unique — reports an ambiguous
  anchor rather than guessing, and returns the current text on a conflict so
  the anchor can be rebuilt in the same step. Content crosses as a tool
  argument and reaches disk base64-encoded, so no payload needs shell
  escaping; the file is spliced by byte offset, moved into place, and verified
  by digest in the same shell call.
- Added a shared failure-family model across the bash and edit tools. A repeat
  is now (class, target) rather than a byte-identical message, so the same
  edit conflict with a different anchor and the same command with a different
  error message are recognised, while different seeds, inputs and commands
  stay distinct. A success retires its family.
- Classified process outcomes: `process_nonzero`, `process_not_found`,
  `process_permission`, `process_lifecycle`, and edit classes beside them,
  each with the strategy transition that applies when it repeats twice.
- `bash` results now carry `exitCode`, `ok` and `failureClass` beside the
  unchanged `text`, so generated code can branch on the outcome instead of
  parsing prose. `text` is byte-for-byte what it was.
- Pointed the execution lane at the deterministic tool instead of describing a
  manual recovery, keeping the prompt the same size.
- Added a deterministic replay covering the eight motivating failure
  scenarios. (The figure first reported here was measured against an incorrect
  Beta.5 baseline; see 0.1.0-beta.6.1 for the corrected result.)

## 0.1.0-beta.5

- Added an execution lane for failure-shaped and implementation work: batch the
  diagnostics, form one root cause, apply one coherent patch, verify once, and
  re-plan only when a result contradicts the explanation. Trivial requests keep
  the zero-overhead path.
- Named the recurring tool-failure classes and their recovery, so an execution
  failure no longer restarts design or scientific reasoning: transport/parser
  errors mean the payload never ran, `old_string was not found` means stale
  local state, and a non-zero exit is usually a result.
- Stopped raising a tool error for every non-zero exit. A non-zero exit now
  returns `exit code: N` with the output; only a spawn failure, a timeout kill,
  or a cancellation raises. On a representative fixture this removes 5 of 6
  spurious tool errors.
- Added an in-band no-progress detector: an identical repeated failure (same
  command, exit code, and first output line) is labelled as such at the point
  of the next decision, with an instruction to change strategy.
- Fixed `bash_job` state precedence: a recorded exit code is terminal, so a
  cancel arriving after a run finished no longer relabels it `cancelled` and
  discards its exit code. `cancel` on a finished job now reports that instead
  of writing a marker.
- Added a transport-fragility benchmark. Naive JS embedding of ordinary
  research payloads survives only 2-4 of 7 cases and each strategy fails on a
  different subset, which is why re-quoting loops; correct escaping survives
  7/7 and base64 round-trips every payload through both quoting layers.

## 0.1.0-beta.4

- Added a scientific reasoning gate: root-cause-first problem framing,
  competing explanations with discriminating tests, cheap alternative
  explanations before acceptance, escalation and de-escalation rules,
  no-progress detection, and a calibrated final verdict.
- Routed deep scientific questions by shape instead of mode keywords, so
  causal, attribution, identifiability, and significance questions reach the
  deep lanes; kept ordinary engineering work on the zero-overhead fast path.
- Staged literature work into batched discovery, decision-relevance triage,
  primary-source verification, contradiction search, and saturation stopping,
  and made the evidence ledger durable across compaction.
- Added a collaboration contract, injected only when AgentTeams is exposed,
  and stopped treating "parallel"/"concurrent" as a collaboration request.
- Added `bash_job`: durable Windows background jobs with a fast launch, plain
  file identity, non-blocking status and logs, process-group cancellation, and
  explicit dead-job detection. `&` inside the bash tool never returned control
  and its timeout killed the launcher rather than the work.
- Preserved exit codes on failing `bash` commands and pointed long work at
  `bash_job`.
- Kept a research lane active across short continuations; previously only the
  literature lane survived a "continue".

## 0.1.0-beta.3

- Lowered long-run compaction pressure to 15%, retained a 4% recent tail, and
  capped Flash summaries at 1,536 tokens after replaying a 657-request Goal.
- Tightened tool-result and fetch output budgets while preserving recent heads
  and tails for diagnosis.

## 0.1.0-beta.2

- Removed ordinary-task mode prompt overhead and made AgentTeams opt-in by
  explicit collaboration intent.
- Lowered long-run compaction pressure to 25%, retained an 8% recent tail,
  routed summaries through Flash with a 2K-token cap, reduced tool-result and
  fetch output budgets, and added batched Code Mode guidance.
- Added completion-claim gates for physical split isolation, audit freshness,
  clean worktrees, proxy disclosure, and scope-bounded negative conclusions.
- Added the stable Windows Git Bash tool and removed the obsolete Solo
  Thinking dependency.
- Fixed first-turn deep requests so research gates survive Minimal bootstrap.

## 0.1.0-beta.1

- Added adaptive Normal and Deep routing.
- Added evidence, innovation-transfer, and verification audit gates.
- Added reproducibility, leakage, statistical, ablation, engineering, runtime,
  GPU utilization, and bug review checks.
- Added bounded AgentTeams visibility and a three-member collaboration limit
  for the recommended profile configuration.
- Added on-demand skill discovery and compaction-aware prompt hints.
- Added Windows installation, verification, and removal scripts.

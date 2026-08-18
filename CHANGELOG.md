# Changelog

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

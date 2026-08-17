# Changelog

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

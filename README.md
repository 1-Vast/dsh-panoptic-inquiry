# Panoptic Inquiry

Panoptic Inquiry is an adaptive DeepSeek Harness preset and bundle for
research, reproduction, model-training review, and engineering audits. It
keeps bounded local tasks on a small tool surface and adds only the review
lanes required by broader work.

The stable preset id is `deep-performance`. Keep that id when upgrading so
existing sessions remain resumable.

## What it does

- Routes bounded work through a Normal path with proportional verification.
- Adds a research evidence gate for literature and paper review.
- Treats cross-domain papers as mechanism candidates, never as designs to copy.
- Adds reproduction, leakage, statistics, ablation, code quality, runtime,
  accelerator utilization, and bug review checks when relevant.
- Uses compact English for internal queries, task packets, and reports while
  answering in the user's language and requested format.
- Hides AgentTeams tools unless collaboration is explicitly requested and
  caps recommended teams at three members.
- Adds no mode-specific prompt text to ordinary work, batches independent
  Code Mode operations, and compacts long sessions at 15% context pressure.
- Replaces visible chain-of-thought requests with auditable evidence ledgers,
  tests, counterexamples, and short decision summaries.

This project structures work and reduces avoidable prompt and tool overhead.
It does not claim model-quality, latency, benchmark, or Fable5 equivalence.

## Evidence policy

The primary evidence pool is limited to recognized top-tier or flagship
peer-reviewed conferences and journals, plus reputable high-quality specialist
or affiliated sub-journals whose review standard meets the field norm.
Exceptional preprints may enter only as provisional leads when their novelty,
methods, experiments, baselines, statistics, ablations, and artifacts support
their claims. A preprint is never the sole confirmed basis for a strong claim.

Recent work from computer vision, natural language processing, and genuinely
analogous fields can inform new mechanisms. Every transfer must document the
source invariant, source assumptions, target analogue, mismatches, required
adaptation, falsifiable prediction, failure modes, and a discriminating
ablation.

## Requirements

- Windows PowerShell 5.1 or PowerShell 7
- Node.js 22.19+ within the 22.x line, or Node.js 24+
- DeepSeek Harness `0.1.0-rc.6`, from a checkout or the `dsh` command
- A `web` profile

The beta has been validated on Windows with a clean npm installation of
DeepSeek Harness `0.1.0-rc.6` and Node.js 24, plus a local `rc.5` source
checkout used during development. The installer accepts only `rc.6`, matching
the declared peer range of the collaboration plugins. Other Harness versions
remain unverified.

## Install from a clone

```powershell
git clone https://github.com/1-Vast/dsh-panoptic-inquiry.git
cd dsh-panoptic-inquiry
.\scripts\install.ps1 -Profile web -DshRoot C:\path\to\deepseek-harness
```

The installer:

1. installs the fixed AgentTeams profile dependency;
2. adds this repository as a DSH profile bundle;
3. validates and copies the `deep-performance` preset;
4. refuses to replace an existing preset unless `-Upgrade` is passed.

It does not change the global default preset, terminate processes, remove
shared plugins, or invoke a model.

## Verify

```powershell
.\scripts\verify.ps1 -Profile web -DshRoot C:\path\to\deepseek-harness
```

Verification runs unit tests, repository checks, package-content checks, and a
DSH config dump. Add `-WebUrl http://127.0.0.1:3080` only when the UI is
already running and an HTTP smoke check is desired.

## Web fetch policy

The distributable preset leaves arbitrary URL fetch disabled. Live search can
still discover papers and stable source links. Do not claim that a paper body
was inspected when only a search result or abstract was available.

Full-page fetch should be enabled only with a provider that enforces public
destination policy at the network layer, including loopback/private/link-local
blocking and redirect/DNS validation. Prompt text is not an SSRF boundary.

## Remove

```powershell
.\scripts\uninstall.ps1 -Profile web -DshRoot C:\path\to\deepseek-harness
```

The preset is archived rather than deleted. The shared AgentTeams dependency
is retained unless `-RemoveSharedDependencies` is explicitly supplied. Sessions that still
refer to `deep-performance` cannot resume after removal until the preset is
restored.

## Data and privacy

AgentTeams may write `.agent-teams/` under a workspace. That directory can
contain task descriptions and research summaries; add it to the workspace
`.gitignore` when it should not be versioned.

Never publish DSH profiles, sessions, settings, credentials, caches, logs,
workspaces, or generated research data with this package.

## Review output

Default user-facing results are concise:

1. conclusion;
2. verified evidence and stable citations;
3. limitations or unverified gaps;
4. the smallest useful next experiment or engineering action.

Internal agent activity and raw logs are omitted unless the user requests
them.

## Long-run cost policy

DeepSeek usage dashboards count cached input again on every model request.
Long tool-driven sessions can therefore report hundreds of millions of tokens
even when most input is a cache hit. This preset reduces that multiplier by
compacting at 15% of the routed model context window, retaining a 4% verbatim
tail, summarizing through Flash with a 1,536-token cap, pruning large tool results,
batching independent tool calls, and ending coherent stages so Goal continuation resumes from durable artifacts. Exact
cost still depends on task length, model pricing, and the number of sequential
model decisions.

Before a research Goal is marked complete, the audit gate checks required
physical split isolation, worktree cleanliness, final-audit freshness, direct
method versus proxy coverage, and claim scope. Unmet contracts require a
conditional completion statement rather than a universal negative claim.

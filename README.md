# Panoptic Inquiry

Panoptic Inquiry is an adaptive DeepSeek Harness preset and bundle for
research, reproduction, model-training review, and engineering audits. It
keeps bounded local tasks on a small tool surface and adds only the review
lanes required by broader work.

The stable preset id is `deep-performance`. Keep that id when upgrading so
existing sessions remain resumable.

## What it does

- Routes bounded work through a Normal path with proportional verification.
- Adds an execution lane to failure-shaped and implementation work: one
  diagnostic batch, one root cause, one coherent patch, one decisive
  verification, plus named recovery for the recurring tool-failure classes.
  Trivial requests still carry no protocol at all.
- Resolves recoverable execution failures in the runtime rather than in prose:
  edits report a status instead of raising, line-ending drift is repaired in
  place, and a repeated failure family names the strategy that should replace
  it (see Tool failures and Mutation safety and its limits).
- Recognises deep scientific questions by shape rather than by mode keywords,
  so "why does this fail to transfer?" or "can this gain be attributed to the
  module?" reach the reasoning lane without being announced as research.
- Adds a scientific reasoning gate for diagnosis: root-cause-first framing,
  two to four competing explanations, discriminating tests, cheap alternative
  explanations, escalation and de-escalation rules, no-progress detection, and
  a calibrated final verdict.
- Adds a research evidence gate for literature and paper review, with batched
  discovery, decision-relevance triage, primary-source verification,
  contradiction search, and saturation-based stopping.
- Treats cross-domain papers as mechanism candidates, never as designs to copy.
- Adds reproduction, leakage, statistics, ablation, code quality, runtime,
  accelerator utilization, and bug review checks when relevant.
- Uses compact English for internal queries, task packets, and reports while
  answering in the user's language and requested format.
- Hides AgentTeams tools unless collaboration is explicitly requested and
  caps recommended teams at three members. Training vocabulary such as
  "tensor parallel" no longer counts as a collaboration request.
- Runs long experiments, downloads, and builds as durable background jobs on
  Windows instead of blocking a tool call (see Long-running work).
- Adds no mode-specific prompt text to ordinary work, spends protocol budget
  per lane, batches independent Code Mode operations, and compacts long
  sessions at 15% context pressure.
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

## Tool failures

A tool failure is classified before it is acted on, so execution trouble does
not restart design or scientific reasoning.

A transport or parser error (`Expected ';'`, an unterminated literal) means the
payload never ran, so nothing about the target program is evidence yet. Naive
embedding of ordinary payloads — quotes, backslashes, `${...}`, triple-quoted
blocks, Unicode — survives only 2-4 of 7 measured cases, and each quoting
strategy fails on a different subset, which is why re-quoting cycles instead of
converging. Correct escaping survives all of them, and base64 round-trips every
payload through both the JavaScript and shell layers.

A rejected edit is stale local state, not a design problem. `edit_apply`
returns a status — `applied`, `conflict`, `ambiguous`, `stale`, `unchanged`,
`missing`, `read_failure`, `too_large`, `write_failure`, `verify_failure`,
`commit_uncertain` — instead of raising. `write_failure` means nothing was
committed and the file is unchanged; `commit_uncertain` means the committing
step did not finish, so the file may or may not have been replaced and must be
re-read before anything else is decided.
CRLF and trailing-whitespace drift is resolved in place when the match is
unique; a non-unique anchor is reported rather than guessed; and a conflict
carries the current text around the closest candidate line, so the anchor can
be rebuilt without re-reading the file. Content travels as a tool argument and
reaches disk base64-encoded, so quotes, backslashes, backticks, `${...}`,
regex and Unicode need no escaping. Leading indentation is never normalised
away, because that would change meaning in Python and YAML, and a replaced
span keeps its own line-ending convention so a CRLF file does not become mixed.

## Mutation safety and its limits

`edit_apply` is confined to the session workspace. Paths are resolved against
the session directory and checked by canonical containment, not by string
prefix, so `D:\work2` is not inside `D:\work`; traversal and absolute paths
outside the root are refused before anything is read. The check fails closed: a
session with no selected workspace has no boundary to check against, so the
mutation is refused rather than proceeding unconfined. Widening this is a
deliberate configuration decision (`allowOutsideWorkspace`), never a side
effect of the Bash lane being able to reach the filesystem.

**This is not a host filesystem sandbox.** Containment is lexical: symlinks and
NTFS junctions are not resolved, so a link inside the workspace pointing
outside it is not detected. The tool runs on the same unsandboxed Git Bash lane
as `bash`, and adds no privilege that lane does not already have.

Each edit builds its replacement from a private snapshot of the file, in
staging files unique to that invocation, and commits with `mv -f` after
re-checking that the target still holds the bytes the edit was built from. That
combination means a concurrent edit cannot produce a file that is a mixture of
two writers, and an edit built against superseded content is refused rather
than committed.

It is **not** a transactional or race-free editor. The check-to-rename window
is narrow but real: an external writer that replaces the target inside that
window is not detected, and the losing writer then reports `verify_failure`
rather than `stale`. Both are truthful non-success reports — what cannot happen
is an `applied` result describing content the file does not hold. Verification
compares the committed file's digest against the intended content.

A repeated failure is tracked as a family — its class and its target — not as
an identical message. The same edit conflict with a different anchor, or the
same command failing with a different error, is recognised as one strategy
that is not working, and the notice names the transition that replaces it.
Different commands, seeds and inputs stay distinct, and a success retires its
family. A successful mutation also retires process-failure history for the
session: rerunning a test after fixing the code is a new experiment, not a
repeat of the failed one.

A non-zero exit is a command-domain result. `bash` returns it as `exit code: N`
with the output rather than raising, because `grep` 1, `diff` 1 and `pytest` 5
are answers; only a spawn failure, a timeout kill, or a cancellation raises.
The result also carries `exitCode`, `ok` and `failureClass` beside the text, so
generated code can branch on the outcome instead of parsing it. Tool success
and command success are separate facts: `ok` is false for a failing test and
for a missing executable, and the class distinguishes them.

## Long-running work

`command &` inside the Windows bash tool does not return control. The
backgrounded child inherits the tool call's output pipes, so the call stays
attached until the child exits, reaches the 300-second shell timeout, and is
killed. Git Bash's `bash.exe` is also an MSYS stub that re-execs, so that kill
reaches the stub while the workload keeps running as an orphan, leaving
partial artifacts behind.

The `bash_job` tool replaces that pattern on Windows. `start` returns a job id
in about 150 ms and the job outlives the call, the step, and the turn;
`status`, `logs`, `cancel`, and `list` never block on the job. Identity lives
in `.dsh-jobs/<job id>/` as plain files — command, cwd, start time, process
ids, log, and exit code — so a job survives compaction and Goal continuation.
Cancellation signals the MSYS process group, which is the only handle that
also covers native children such as `python.exe`; `taskkill /T` alone does
not, because MSYS reparents at the Windows level.

A recorded exit code is terminal: a cancel arriving after a run finished
reports that it already finished instead of relabelling the run as cancelled.
A job reported as `died` has no recorded exit code: its log is partial output
and must never be read as a completed run. Add `.dsh-jobs/` to the workspace
`.gitignore` when job logs should not be versioned.

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

AgentTeams may write `.agent-teams/` under a workspace, and `bash_job` writes
`.dsh-jobs/`. Those directories can contain task descriptions, research
summaries, command text, and job logs; add them to the workspace `.gitignore`
when they should not be versioned.

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

Two independent mechanisms keep long sessions affordable, and they should not
be confused. **Context suppression** slows growth: tool-result pruning, batched
execution, and the removal of the skill-catalog and workspace-instruction
injections. **Compaction** transforms accumulated history into a summary once
context pressure reaches `thresholdRatio`, keeping `retainRatio` of recent turns
verbatim. Measured reductions between preset generations came from the first
mechanism; compaction only pays off when its summaries actually succeed.

The summary budget is sized against what compaction must represent, not
minimised. At a 0.15 threshold with a 0.04 tail the summariser receives roughly
0.11 of the routed window per compaction; a 1536-token cap made that a 37:1 to
72:1 compression and truncated every attempt. Because the cap is a small
fraction of the tokens the summarisation call already processes, and because the
retained tail dominates post-compaction context, a starved cap wastes the whole
call to save very little. If measured summary output regularly exceeds 90% of
the cap, raise it rather than accepting truncation.

Before a research Goal is marked complete, the audit gate checks required
physical split isolation, worktree cleanliness, final-audit freshness, direct
method versus proxy coverage, and claim scope. Unmet contracts require a
conditional completion statement rather than a universal negative claim.

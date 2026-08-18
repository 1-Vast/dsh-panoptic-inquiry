/**
 * failure-signature — one shared, conservative notion of "we have already
 * tried this failing strategy" across the tools this repository owns.
 *
 * Beta.5 detected repeats inside the bash tool only, keyed on a byte-identical
 * command, exit code and first output line. Real loops are not byte-identical:
 * the same edit conflict recurs with a different anchor, and the same broken
 * command recurs with a different flag. This module normalises a failure into
 * a FAMILY — (class, target) — so a second failure of the same family on the
 * same target is recognised even when the message differs, and says which
 * strategy transition is available.
 *
 * Deliberately conservative, because a false positive suppresses legitimate
 * work:
 *  - only FAILURES are counted; a successful call never contributes;
 *  - process failures keep the VERBATIM command in the signature, so repeated
 *    training runs, multiple seeds and benchmarks over different inputs stay
 *    distinct;
 *  - edit failures drop the anchor and key on the path, because retrying a
 *    different exact string against the same stale file IS the loop;
 *  - message text is normalised (positions, offsets, hex, quoted fragments)
 *    only to decide the class, never to merge different commands.
 *
 * BOUNDARY: Code Mode transport/parser failures happen in the host before any
 * tool of this repository executes, so they cannot be observed or counted
 * here. Their recovery stays prompt-level (the execution lane).
 */

/** Failure classes this repository can actually observe at runtime. */
export const FAILURE_CLASS = {
  processNonZero: 'process_nonzero',
  processNotFound: 'process_not_found',
  processPermission: 'process_permission',
  processLifecycle: 'process_lifecycle',
  processSpawn: 'process_spawn',
  editConflict: 'edit_conflict',
  editAmbiguous: 'edit_ambiguous',
  editStale: 'edit_stale',
  readFailure: 'read_failure',
  writeFailure: 'write_failure',
  verifyFailure: 'verify_failure',
}

/** Strategy transition offered when a family repeats. One line, per class. */
const TRANSITION = {
  [FAILURE_CLASS.processNonZero]: 'inspect the state this command depends on, or change the command shape — do not run it again unchanged',
  [FAILURE_CLASS.processNotFound]: 'the executable is missing or misspelled: fix PATH or install it; editing the program will not help',
  [FAILURE_CLASS.processPermission]: 'this is a permission or lock problem, not a program problem: fix access, ownership, or the holder of the file',
  [FAILURE_CLASS.processLifecycle]: 'the process was killed rather than finishing: start it with bash_job instead of a blocking call',
  [FAILURE_CLASS.processSpawn]: 'the shell itself could not start: verify the interpreter path before retrying',
  [FAILURE_CLASS.editConflict]: 'stop matching exact strings against this file: rewrite the whole region or the whole file with edit_apply',
  [FAILURE_CLASS.editAmbiguous]: 'the anchor is not unique: extend it with surrounding lines, or target one span explicitly',
  [FAILURE_CLASS.editStale]: 'the file changed under you: re-read it and rebuild the patch against current content',
  [FAILURE_CLASS.readFailure]: 'confirm the path exists and is readable before editing it',
  [FAILURE_CLASS.writeFailure]: 'the write itself failed: check the directory, disk, and file lock before retrying the same content',
  [FAILURE_CLASS.verifyFailure]: 'the file on disk does not match what was written: re-read it before any further edit',
}

/** Classify a finished process outcome. Only failures return a class. */
export function classifyProcess({ exitCode, cancelled = false, output = '' }) {
  if (!Number.isInteger(exitCode)) {
    return cancelled === true ? undefined : FAILURE_CLASS.processLifecycle
  }
  if (exitCode === 0) return undefined
  if (exitCode === 127) return FAILURE_CLASS.processNotFound
  if (exitCode === 126) return FAILURE_CLASS.processPermission
  // A shell reports a missing command as 127, but a wrapper may pass the text
  // through with its own code; keep the check narrow and text-anchored.
  if (/command not found|: not found$/im.test(output)) return FAILURE_CLASS.processNotFound
  if (/permission denied/i.test(output)) return FAILURE_CLASS.processPermission
  return FAILURE_CLASS.processNonZero
}

/**
 * Strip the parts of a message that vary between repetitions of the SAME
 * failure — offsets, positions, line/column numbers, hex addresses, and
 * timestamps — so `Expected ';' at position 173` and `Expected a semicolon`
 * collapse when they belong to one class.
 */
export function normalizeDetail(message) {
  return String(message ?? '')
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * Family key. `target` is the file path for edits and the verbatim command for
 * processes: that difference is the whole point — a different command is a
 * different experiment, a different anchor in one file is the same strategy.
 */
export function failureSignature({ failureClass, target }) {
  return [failureClass, String(target ?? '')].join(' :: ')
}

/** Per-session failure counts. Weak keys: a closed session is not retained. */
const failuresBySession = new WeakMap()
const MAX_TRACKED_SIGNATURES = 64

/** Record one failure and return how many times this family has now failed. */
export function noteFailure(session, signature) {
  if (session === undefined || session === null) return 1
  let seen = failuresBySession.get(session)
  if (seen === undefined) {
    seen = new Map()
    failuresBySession.set(session, seen)
  }
  const count = (seen.get(signature) ?? 0) + 1
  seen.delete(signature)
  seen.set(signature, count)
  if (seen.size > MAX_TRACKED_SIGNATURES) seen.delete(seen.keys().next().value)
  return count
}

/** Clear one family after it succeeds, so a later failure starts fresh. */
export function clearFailure(session, signature) {
  const seen = session === undefined || session === null ? undefined : failuresBySession.get(session)
  if (seen !== undefined) seen.delete(signature)
}

/** Process classes, whose history is invalidated by a successful mutation. */
const PROCESS_CLASSES = new Set([
  FAILURE_CLASS.processNonZero,
  FAILURE_CLASS.processNotFound,
  FAILURE_CLASS.processPermission,
  FAILURE_CLASS.processLifecycle,
  FAILURE_CLASS.processSpawn,
])

/**
 * Forget process-failure history for one session.
 *
 * A successful mutation changes the state every earlier command ran against,
 * so `pytest` failing before an edit and `pytest` failing after it are not the
 * same strategy repeated — they are two different experiments that happen to
 * share a command line. Without this, the second failure would be reported as
 * no progress and the caller would be told to stop doing the right thing.
 *
 * Edit families are deliberately NOT cleared here: repeated conflicts against
 * a file are still one failing strategy, and `edit_apply` retires those itself
 * when an edit actually lands.
 */
export function clearProcessFailures(session) {
  const seen = session === undefined || session === null ? undefined : failuresBySession.get(session)
  if (seen === undefined) return 0
  let removed = 0
  for (const key of [...seen.keys()]) {
    const [failureClass] = key.split(' :: ')
    if (PROCESS_CLASSES.has(failureClass)) {
      seen.delete(key)
      removed += 1
    }
  }
  return removed
}

/**
 * The in-band notice. Silent on the first failure — one failure deserves a
 * cheap correction, not a strategy change.
 */
export function repeatNotice(count, failureClass) {
  if (count < 2) return ''
  const transition = TRANSITION[failureClass] ?? 'change the approach rather than repeating it'
  return `\n\n[no progress: ${failureClass} failed ${count}x on this target.`
    + ` Another variation of the same approach will not work — ${transition}.]`
}

/**
 * One call: record the failure and produce its notice. Returns the count so a
 * caller can also expose it as structured state.
 */
export function trackFailure(session, { failureClass, target }) {
  const signature = failureSignature({ failureClass, target })
  const count = noteFailure(session, signature)
  return { signature, count, notice: repeatNotice(count, failureClass) }
}

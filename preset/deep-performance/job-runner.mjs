/**
 * job-runner — durable background jobs for the Windows Git Bash lane.
 *
 * WHY (verified runtime behavior, not shell folklore):
 *  - `bash.exe` from Git for Windows is an MSYS stub: the process the host
 *    spawns re-execs, and the shell that actually runs the payload lives under
 *    a DIFFERENT Windows pid. Cancelling or timing out the spawn handle kills
 *    the stub and leaves the workload running as an orphan.
 *  - A `&`-backgrounded child INHERITS the tool call's stdout/stderr pipes, so
 *    the collected streams do not reach EOF until the child exits. `cmd &`
 *    therefore does NOT return control to the model: the launch call stays
 *    attached for the whole job, hits the shell timeout, and is killed — while
 *    the payload survives and keeps writing partial artifacts.
 *
 * Both effects were measured on Windows before this plugin was written; the
 * regression test in `test/job-runner.test.mjs` reproduces them.
 *
 * WHAT THIS OWNS: the tool implementation and the shell text it passes. The
 * subprocess service and the host `jobs` registry are host-plane and cannot be
 * enrolled from here, so job identity is kept as plain files — inert records,
 * not a second process manager. Files survive the model step, compaction, and
 * session continuation, and stay readable with ordinary tools.
 *
 * Job directory layout (`<jobsDir>/<job id>/`):
 *   payload.sh  the command, verbatim        log        merged stdout/stderr
 *   cwd         working directory            exit       exit code (completion marker)
 *   started     ISO start timestamp          cancelled  explicit cancellation marker
 *   winpid      Windows pid of the job shell run.sh / launch.log
 *
 * State is derived, never assumed: `exit` present = finished (code preserved);
 * `cancelled` marker = cancelled; pid gone with neither = died unexpectedly, so
 * partial output is never reported as a completed run.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'job-runner'

/** The subprocess seam and the tool registry must exist before this registers. */
export const inject = ['subprocess', 'tools']

const DEFAULT_CONTROL_TIMEOUT_MS = 30000
const DEFAULT_JOBS_DIR = '.dsh-jobs'
const DEFAULT_MAX_LOG_CHARS = 2400
const JOB_ID_PATTERN = /^job-[0-9a-z-]+$/

/** Native Windows paths cross into the shell domain with forward slashes. */
export function toShellPath(value) {
  return String(value).split('\\').join('/')
}

/** Quote one value for the bash single-quote domain. */
export function shellQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`
}

/** Stable, sortable job id. Time first so `list` reads chronologically. */
export function buildJobId(now = Date.now(), entropy = Math.random()) {
  const stamp = new Date(now).toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const suffix = Math.floor(entropy * 46656).toString(36).padStart(3, '0')
  return `job-${stamp}-${suffix}`
}

/**
 * The supervisor script. It runs INSIDE the job directory (nohup inherits the
 * launcher's cwd), records the ids the job is later inspected and cancelled
 * by, runs the payload in the requested workdir with every stream redirected
 * to the log, then records the exit code.
 *
 * Both ids come from `ps -W`, and both are needed:
 *  - the pid the host holds belongs to the MSYS stub, not to this shell;
 *  - MSYS `fork` reparents at the Windows level, so `taskkill /T` walks a tree
 *    that does NOT contain the payload. The MSYS process GROUP does: the
 *    supervisor, the payload shell, its msys children and its native children
 *    all share one pgid, and signalling that group stops all of them.
 */
const RUN_SCRIPT = [
  'JOB_DIR="$PWD"',
  `IDS="$(ps -W | awk -v p=$$ '$1==p {print $3, $4}')"`,
  'echo "${IDS%% *}" > "$JOB_DIR/pgid"',
  'echo "${IDS##* }" > "$JOB_DIR/winpid"',
  'cd "$(cat "$JOB_DIR/cwd")" 2>/dev/null || cd "$JOB_DIR"',
  'bash "$JOB_DIR/payload.sh" > "$JOB_DIR/log" 2>&1',
  'echo $? > "$JOB_DIR/exit"',
].join('\n')

/**
 * Compose the launch command. The payload crosses into the job directory
 * through a QUOTED heredoc, so it is written verbatim with no escaping layer
 * to get wrong; the caller rejects a payload containing the delimiter.
 *
 * The supervisor is started with `nohup … > launch.log 2>&1 &`: every stream is
 * redirected away from the tool call's pipes, which is what lets this launcher
 * return in ~150ms instead of staying attached for the job's lifetime.
 */
export function composeLaunch({ jobDir, workdir, command, delimiter }) {
  return [
    'set -e',
    `mkdir -p ${shellQuote(jobDir)}`,
    `cd ${shellQuote(jobDir)}`,
    `cat > payload.sh <<'${delimiter}'`,
    command,
    delimiter,
    `cat > run.sh <<'${delimiter}'`,
    RUN_SCRIPT,
    delimiter,
    `printf '%s' ${shellQuote(workdir)} > cwd`,
    'date +%Y-%m-%dT%H:%M:%S%z > started',
    'nohup bash run.sh > launch.log 2>&1 &',
    'echo launched',
  ].join('\n')
}

/** Emit one job's raw facts as key=value lines. Never blocks on the job. */
function statusBlock(jobDir) {
  return [
    `cd ${shellQuote(jobDir)} 2>/dev/null || { echo 'present=0'; exit 0; }`,
    `echo 'present=1'`,
    `printf 'winpid=%s\\n' "$(cat winpid 2>/dev/null)"`,
    `printf 'pgid=%s\\n' "$(cat pgid 2>/dev/null)"`,
    `printf 'exit=%s\\n' "$(cat exit 2>/dev/null)"`,
    `printf 'cancelled=%s\\n' "$(cat cancelled 2>/dev/null)"`,
    `printf 'started=%s\\n' "$(cat started 2>/dev/null)"`,
    `printf 'logbytes=%s\\n' "$(wc -c < log 2>/dev/null | tr -d ' ')"`,
    `printf 'idleseconds=%s\\n' "$(( $(date +%s) - $(date -r log +%s 2>/dev/null || date +%s) ))"`,
    // Liveness counts the whole process group, so a job whose supervisor has
    // been replaced but whose payload still runs is never reported as dead.
    `printf 'alive=%s\\n' "$(ps -W | awk -v g="$(cat pgid 2>/dev/null)" 'g != "" && $3 == g {n++} END {print n+0}')"`,
    `printf 'command=%s\\n' "$(head -n 1 payload.sh 2>/dev/null)"`,
  ].join('\n')
}

/** Parse one `key=value` block into a record. */
export function parseBlock(text) {
  const record = {}
  for (const line of String(text).split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    record[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return record
}

/**
 * Derive job state from durable facts only.
 *
 * `exit` is written by the supervisor after the payload returns, so its
 * presence is the ONLY completion evidence; a job whose shell is gone without
 * it either died or was cancelled, and its log is partial output.
 */
export function classifyState(record) {
  if (record.present !== '1') return { state: 'missing' }
  // A recorded exit code is TERMINAL: it is the provenance of a run that
  // actually finished. A cancel arriving afterwards (or racing the last
  // instruction) must not relabel that run as cancelled and discard the code.
  if (record.exit) {
    const code = Number(record.exit)
    const state = Number.isInteger(code) && code === 0 ? 'completed' : 'failed'
    return record.cancelled ? { state, exitCode: code, lateCancel: true } : { state, exitCode: code }
  }
  if (record.cancelled) return { state: 'cancelled' }
  if (!record.winpid) return { state: 'starting' }
  if (Number(record.alive) > 0) return { state: 'running' }
  return { state: 'died' }
}

/** One human-readable status line per job. */
export function renderStatus(jobId, record) {
  const verdict = classifyState(record)
  const parts = [`job ${jobId}: ${verdict.state}`]
  if (verdict.exitCode !== undefined) parts.push(`exit code ${verdict.exitCode}`)
  if (record.winpid) parts.push(`pid ${record.winpid}`)
  if (record.started) parts.push(`started ${record.started}`)
  if (record.logbytes) parts.push(`log ${record.logbytes} bytes`)
  if (record.idleseconds && verdict.state === 'running') parts.push(`no new output for ${record.idleseconds}s`)
  if (record.command) parts.push(`command: ${record.command}`)
  if (verdict.lateCancel) parts.push('a cancel arrived after the run finished and did not change its outcome')
  if (verdict.state === 'died') parts.push('no exit code recorded — treat the log as PARTIAL output, not a completed run')
  return parts.join(' | ')
}

/** Register the `bash_job` control tool. */
export function apply(ctx, config) {
  const bashPath = typeof config?.bashPath === 'string' && config.bashPath.length > 0 ? config.bashPath : 'bash'
  const controlTimeoutMs = Number.isSafeInteger(config?.controlTimeoutMs) && config.controlTimeoutMs > 0
    ? config.controlTimeoutMs
    : DEFAULT_CONTROL_TIMEOUT_MS
  const jobsDir = typeof config?.jobsDir === 'string' && config.jobsDir.length > 0 ? config.jobsDir : DEFAULT_JOBS_DIR
  const maxLogChars = Number.isSafeInteger(config?.maxLogChars) && config.maxLogChars > 0
    ? config.maxLogChars
    : DEFAULT_MAX_LOG_CHARS

  /** Run one short control command. Control calls never wait on a job. */
  const control = async (command, exec, cwd) => {
    const shell = await ctx.subprocess.resolveExecutable(bashPath, undefined, exec?.signal)
    const handle = ctx.subprocess.spawn({
      argv: [shell, '-c', command],
      ...(cwd === undefined ? {} : { cwd }),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
      graceMs: 3000,
    })
    const outcome = await handle.done
    let stdout = ''
    let stderr = ''
    try {
      stdout = handle.collected.stdout.readFrom(0).text
      stderr = handle.collected.stderr.readFrom(0).text
    } catch {
      // Some subprocess backends may not expose collected readers.
    }
    return { stdout, stderr, exitCode: outcome?.exitCode }
  }

  const sessionCwd = exec => exec?.agent?.session?.header?.cwd
  const rootFor = exec => `${toShellPath(sessionCwd(exec) ?? '.')}/${toShellPath(jobsDir)}`
  const dirFor = (exec, jobId) => `${rootFor(exec)}/${jobId}`

  const requireJobId = (value) => {
    if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
      throw new Error(`job_id must be an id returned by start (got ${JSON.stringify(value)})`)
    }
    return value
  }

  ctx.tools.register({
    name: 'bash_job',
    description: [
      'Durable background job for work that outlives an ordinary tool call: experiments, training runs, downloads, long builds.',
      'Verified on this platform: `command &` inside the `bash` tool does NOT return control — the child inherits the pipes and holds the call open until it finishes, and the shell timeout then kills the launcher WITHOUT killing the work. Use this tool instead of backgrounding by hand.',
      'start  — launch one command and return immediately with a job id; the job keeps running after this call, this step, and this turn end.',
      'status — non-blocking state: starting/running/completed/failed/cancelled/died, exit code, log size, and how long the log has been idle.',
      'logs   — bounded tail of the merged stdout/stderr log.',
      'cancel — terminate the job process tree explicitly.',
      'list   — every job of this workspace with its state.',
      'Do not poll in a loop. Launch, do independent work, then inspect once at a boundary chosen from the expected runtime or a log milestone. A job in state "died" has NO exit code: its log is partial output, never a completed run.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'logs', 'cancel', 'list'], description: 'lifecycle operation' },
        command: { type: 'string', description: 'start: the bash command to run in the background' },
        job_id: { type: 'string', description: 'status/logs/cancel: the id returned by start' },
        workdir: { type: 'string', description: 'start: working directory; defaults to the session cwd' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string' } }, required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: controlTimeoutMs,
    async execute(args, exec) {
      const action = args.action

      if (action === 'start') {
        if (typeof args.command !== 'string' || args.command.trim().length === 0) {
          throw new Error('start requires a non-empty command')
        }
        const jobId = buildJobId()
        const delimiter = `DSH_JOB_${jobId.replace(/-/g, '_').toUpperCase()}`
        if (args.command.split('\n').some(line => line.trim() === delimiter)) {
          throw new Error('command contains the internal heredoc delimiter; rename that line')
        }
        const jobDir = dirFor(exec, jobId)
        const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
          ? args.workdir
          : sessionCwd(exec) ?? '.'
        const shellWorkdir = toShellPath(workdir)
        const launch = await control(
          composeLaunch({ jobDir, workdir: shellWorkdir, command: args.command, delimiter }),
          exec,
          sessionCwd(exec),
        )
        if (launch.exitCode !== 0) {
          throw new Error(`job launch failed: ${launch.stderr || launch.stdout || `exit code ${launch.exitCode}`}`)
        }
        return {
          text: [
            `Started ${jobId} (still running after this call returns).`,
            `Job directory: ${jobDir}`,
            `Log: ${jobDir}/log`,
            `Inspect later with bash_job status/logs (job_id ${jobId}); cancel with bash_job cancel.`,
            'Do the next independent piece of work now instead of polling.',
          ].join('\n'),
        }
      }

      if (action === 'status') {
        const jobId = requireJobId(args.job_id)
        const result = await control(statusBlock(dirFor(exec, jobId)), exec, sessionCwd(exec))
        const record = parseBlock(result.stdout)
        if (record.present !== '1') return { text: `job ${jobId}: missing (no job directory under ${rootFor(exec)})` }
        return { text: renderStatus(jobId, record) }
      }

      if (action === 'logs') {
        const jobId = requireJobId(args.job_id)
        const jobDir = dirFor(exec, jobId)
        const result = await control(
          `tail -c ${maxLogChars} ${shellQuote(`${jobDir}/log`)} 2>/dev/null || echo '(no log yet)'`,
          exec,
          sessionCwd(exec),
        )
        const body = result.stdout.length > 0 ? result.stdout : '(no output yet)'
        return { text: `job ${jobId} — last ${maxLogChars} bytes of log:\n${body}` }
      }

      if (action === 'cancel') {
        const jobId = requireJobId(args.job_id)
        const jobDir = dirFor(exec, jobId)
        // Mark first: a cancellation that races the kill must still be
        // distinguishable from an unexplained death.
        const result = await control([
          `cd ${shellQuote(jobDir)} 2>/dev/null || { echo 'missing'; exit 0; }`,
          // Finished is terminal: never write a cancel marker over a real
          // outcome, so the exit code stays the record of what happened.
          `if [ -f exit ]; then echo "already finished with exit code $(cat exit)"; exit 0; fi`,
          `date +%Y-%m-%dT%H:%M:%S%z > cancelled`,
          `GP="$(cat pgid 2>/dev/null)"`,
          `WP="$(cat winpid 2>/dev/null)"`,
          `if [ -z "$GP" ] && [ -z "$WP" ]; then echo 'cancelled before the job shell registered'; exit 0; fi`,
          // The MSYS process group is the only handle that covers the payload
          // and its native children; taskkill is a fallback for a supervisor
          // that outlived the group signal.
          `if [ -n "$GP" ]; then kill -- -"$GP" 2>/dev/null; sleep 1; kill -9 -- -"$GP" 2>/dev/null; fi`,
          `if [ -n "$WP" ]; then taskkill //T //F //PID "$WP" > /dev/null 2>&1; fi`,
          `echo "cancelled (process group $GP)"`,
        ].join('\n'), exec, sessionCwd(exec))
        return { text: `job ${jobId}: ${result.stdout.trim() || 'cancel requested'}` }
      }

      if (action === 'list') {
        const root = rootFor(exec)
        const result = await control([
          `cd ${shellQuote(root)} 2>/dev/null || { echo 'none'; exit 0; }`,
          'for d in job-*/; do',
          `  [ -d "$d" ] || continue`,
          `  echo "job=\${d%/}"`,
          `  ( cd "$d" && ${statusBlock('.').split('\n').slice(1).join('\n')} )`,
          'done',
        ].join('\n'), exec, sessionCwd(exec))
        const blocks = result.stdout.split(/^job=/m).slice(1)
        if (blocks.length === 0) return { text: `No jobs under ${root}.` }
        const lines = blocks.map((block) => {
          const jobId = block.split('\n', 1)[0].trim()
          return renderStatus(jobId, parseBlock(block))
        })
        return { text: `${lines.length} job(s) under ${root}:\n${lines.join('\n')}` }
      }

      throw new Error(`unknown action ${JSON.stringify(action)}`)
    },
  })
}

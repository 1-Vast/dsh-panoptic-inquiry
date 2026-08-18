/**
 * edit-apply — mutation with structured outcomes instead of an opaque
 * exception, so a recoverable edit conflict is resolved by the execution layer
 * rather than by another round of model reasoning.
 *
 * WHY: `old_string was not found` is the commonest recoverable failure, and its
 * commonest causes are deterministic and local — CRLF versus LF, trailing
 * whitespace, indentation drift, or an anchor that is no longer unique. Beta.5
 * could only advise a recovery in prose; the model then spent a read, a retry
 * and two reasoning turns rediscovering a fact the runtime can compute.
 *
 * This tool does that work in process:
 *   READ current bytes → MATCH (exact, then a conservative tolerant pass)
 *   → SPLICE → VERIFY by digest
 * and returns a STATUS the caller can branch on: applied, conflict, ambiguous,
 * stale, unchanged, missing, too_large, write_failure, verify_failure. Under
 * Code Mode a conflict carries the current span verbatim, so the generated code
 * can retry with the corrected anchor inside the SAME execution — no model
 * decision boundary for a mechanical fix.
 *
 * MECHANISM (every step measured on this platform before it was used):
 *  - content crosses as a structured tool argument, never through shell
 *    quoting, and reaches disk base64-encoded, which round-trips every payload
 *    class the transport benchmark covers;
 *  - only the REPLACEMENT crosses argv. The file is spliced by byte offset
 *    (`head -c` + payload + `tail -c +n`), so cost follows the patch size, not
 *    the file size — a 1 MB file takes one shell call;
 *  - argv has a hard practical ceiling here (a single base64 argument above
 *    ~5 KB fails, and above ~40 KB the process does not start), so a large
 *    payload is appended in verified-size chunks;
 *  - the new file is built beside the target and moved into place with `mv -f`,
 *    so a failed decode or write leaves the original intact;
 *  - `sha256sum` runs in the same shell call as the move, so verification adds
 *    no round trip.
 *
 * BOUNDARY: this uses the same subprocess seam and the same Git Bash lane as
 * the `bash` tool, which already runs unsandboxed on Windows; it adds no
 * privilege that lane does not have. It is mounted on Windows only, beside
 * `custom-bash`. The host `str_replace_editor` stays registered and unchanged.
 */

import { createHash } from 'node:crypto'
import { FAILURE_CLASS, trackFailure, clearFailure, failureSignature } from './failure-signature.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'edit-apply'

/** The subprocess seam and the tool registry must exist before this registers. */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
/** Verified safe single-argument base64 size on this platform (fails ~5.3 KB). */
const CHUNK_B64_CHARS = 4000
const TEMP_SUFFIX = '.dsh-edit'
/** Context returned around a failed match so the caller can repair in place. */
const SPAN_CONTEXT_LINES = 3

/** Native Windows paths cross into the shell domain with forward slashes. */
export function toShellPath(value) {
  return String(value).split('\\').join('/')
}

/** Quote one value for the bash single-quote domain. */
export function shellQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`
}

/** Line number (1-based) of a byte offset. */
export function lineAt(buffer, offset) {
  let line = 1
  for (let index = 0; index < offset && index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) line += 1
  }
  return line
}

/** Every byte offset where `needle` occurs in `haystack`. */
export function allIndexes(haystack, needle) {
  const found = []
  if (needle.length === 0) return found
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return found
    found.push(at)
    from = at + 1
  }
}

/**
 * Normalise only what drifts mechanically between a remembered anchor and the
 * bytes on disk: line endings, and whitespace at the end of a line. Leading
 * indentation is preserved, because changing it would change meaning in
 * Python and YAML.
 */
export function normalizeForMatch(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
}

/**
 * Locate `oldString` in `content`.
 *
 * Exact matching first. If that finds nothing, retry on a
 * line-ending/trailing-whitespace-normalised copy and map the hit back to real
 * byte offsets — but ONLY when that tolerant pass finds exactly one match.
 * Ambiguity is reported, never guessed.
 */
export function locate(content, oldString) {
  const exact = allIndexes(content, oldString)
  if (exact.length === 1) return { kind: 'exact', start: exact[0], end: exact[0] + oldString.length }
  if (exact.length > 1) return { kind: 'ambiguous', offsets: exact }

  const normalizedContent = normalizeForMatch(content)
  const normalizedNeedle = normalizeForMatch(oldString)
  if (normalizedNeedle.length === 0) return { kind: 'missing' }
  const loose = allIndexes(normalizedContent, normalizedNeedle)
  if (loose.length !== 1) {
    return loose.length > 1 ? { kind: 'ambiguous', offsets: [] } : { kind: 'missing' }
  }

  // Walk the original content and the normalised copy together to translate
  // the normalised offset back to a real span.
  const start = originalOffset(content, loose[0])
  const end = originalOffset(content, loose[0] + normalizedNeedle.length)
  if (start === undefined || end === undefined || end <= start) return { kind: 'missing' }
  return { kind: 'tolerant', start, end }
}

/** Map an offset in the normalised copy back onto the original string. */
function originalOffset(content, normalizedTarget) {
  let normalized = 0
  let index = 0
  while (index <= content.length) {
    if (normalized === normalizedTarget) return index
    const char = content[index]
    if (char === '\r' && content[index + 1] === '\n') {
      index += 1
      continue
    }
    if ((char === ' ' || char === '\t') && isTrailingWhitespace(content, index)) {
      index += 1
      continue
    }
    index += 1
    normalized += 1
  }
  return undefined
}

/** Whether the whitespace at `index` runs to the end of its line. */
function isTrailingWhitespace(content, index) {
  for (let scan = index; scan < content.length; scan += 1) {
    const char = content[scan]
    if (char === '\n' || (char === '\r' && content[scan + 1] === '\n')) return true
    if (char !== ' ' && char !== '\t') return false
  }
  return true
}

/** The current text around a span, so a caller can rebuild its anchor. */
export function spanContext(content, start, end) {
  const lines = content.split('\n')
  const startLine = lineAt(Buffer.from(content, 'utf8'), Buffer.byteLength(content.slice(0, start), 'utf8'))
  const endLine = lineAt(Buffer.from(content, 'utf8'), Buffer.byteLength(content.slice(0, end), 'utf8'))
  const from = Math.max(0, startLine - 1 - SPAN_CONTEXT_LINES)
  const to = Math.min(lines.length, endLine + SPAN_CONTEXT_LINES)
  return { firstLine: from + 1, text: lines.slice(from, to).join('\n') }
}

/**
 * Best current candidate for a failed anchor: the longest run of the anchor's
 * own lines that still exists, so the caller sees what the file actually holds
 * rather than being told only that its string was absent.
 */
export function nearestCandidate(content, oldString) {
  const wanted = normalizeForMatch(oldString).split('\n').filter(line => line.trim().length > 0)
  const normalizedContent = normalizeForMatch(content)
  for (const line of wanted) {
    const at = normalizedContent.indexOf(line)
    if (at === -1) continue
    const real = originalOffset(content, at)
    if (real === undefined) continue
    return spanContext(content, real, real + line.length)
  }
  return undefined
}

/** Read command: size guard first, then exact bytes as base64. */
export function readCommand(shellPath, maxBytes) {
  const quoted = shellQuote(shellPath)
  return [
    `if [ ! -f ${quoted} ]; then echo MISSING; exit 0; fi`,
    `SIZE=$(wc -c < ${quoted} | tr -d ' ')`,
    `if [ "$SIZE" -gt ${maxBytes} ]; then echo "TOO_LARGE $SIZE"; exit 0; fi`,
    `echo "OK $SIZE"`,
    `base64 -w0 < ${quoted}`,
  ].join('\n')
}

/**
 * Commands that splice `replacement` into [start, end) and verify the result.
 * One command for an ordinary patch; extra append commands only when the
 * payload exceeds the verified argv ceiling.
 */
export function writeCommands({ shellPath, start, end, replacementB64, digest }) {
  const quoted = shellQuote(shellPath)
  const temp = shellQuote(`${shellPath}${TEMP_SUFFIX}`)
  const payload = shellQuote(`${shellPath}${TEMP_SUFFIX}.b64`)
  const commands = []

  if (replacementB64.length <= CHUNK_B64_CHARS) {
    commands.push([
      `head -c ${start} ${quoted} > ${temp}`,
      `printf %s ${shellQuote(replacementB64)} | base64 -d >> ${temp}`,
      `tail -c +${end + 1} ${quoted} >> ${temp}`,
      `mv -f ${temp} ${quoted}`,
      `sha256sum ${quoted} | cut -d' ' -f1`,
    ].join(' && '))
    return commands
  }

  // Large replacement: stage the base64 in verified-size pieces, decode once.
  commands.push(`: > ${payload}`)
  for (let at = 0; at < replacementB64.length; at += CHUNK_B64_CHARS) {
    commands.push(`printf %s ${shellQuote(replacementB64.slice(at, at + CHUNK_B64_CHARS))} >> ${payload}`)
  }
  commands.push([
    `head -c ${start} ${quoted} > ${temp}`,
    `base64 -d < ${payload} >> ${temp}`,
    `tail -c +${end + 1} ${quoted} >> ${temp}`,
    `mv -f ${temp} ${quoted}`,
    `rm -f ${payload}`,
    `sha256sum ${quoted} | cut -d' ' -f1`,
  ].join(' && '))
  void digest
  return commands
}

/** Register the `edit_apply` tool. */
export function apply(ctx, config) {
  const bashPath = typeof config?.bashPath === 'string' && config.bashPath.length > 0 ? config.bashPath : 'bash'
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxFileBytes = Number.isSafeInteger(config?.maxFileBytes) && config.maxFileBytes > 0
    ? config.maxFileBytes
    : DEFAULT_MAX_FILE_BYTES

  const run = async (command, exec) => {
    const shell = await ctx.subprocess.resolveExecutable(bashPath, undefined, exec?.signal)
    const handle = ctx.subprocess.spawn({
      argv: [shell, '-c', command],
      ...(exec?.agent?.session?.header?.cwd === undefined ? {} : { cwd: exec.agent.session.header.cwd }),
      stdio: { stdin: 'ignore', stdout: { maxBytes: maxFileBytes * 2 }, stderr: { maxBytes: 65536 } },
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

  ctx.tools.register({
    name: 'edit_apply',
    description: [
      'Edit one file and get a STATUS back instead of an exception, so a recoverable conflict does not need a new round of reasoning.',
      'Replace a span: pass path + old_string + new_string. Rewrite the file: pass path + content. Optional expected_sha256 rejects an edit built against stale content.',
      'status is one of: applied | conflict | ambiguous | stale | unchanged | missing | too_large | write_failure | verify_failure.',
      'A line-ending or trailing-whitespace difference is resolved automatically when the match is unique (status applied, tolerant true) — do not re-quote or re-indent by hand to work around it.',
      'On conflict the result carries the CURRENT text around the closest candidate span with its line number: rebuild old_string from that text and call again in the same step rather than re-reading the file.',
      'On ambiguous the anchor matches several places: extend old_string with surrounding lines.',
      'Content travels as a tool argument and reaches disk base64-encoded, so quotes, backslashes, backticks, ${...}, regex and Unicode need no escaping. The write is staged beside the target and moved into place, and the result is verified by digest.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file to edit' },
        old_string: { type: 'string', description: 'exact span to replace' },
        new_string: { type: 'string', description: 'replacement for old_string' },
        content: { type: 'string', description: 'full new file content (instead of old_string/new_string)' },
        expected_sha256: { type: 'string', description: 'reject the edit if the file no longer has this digest' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: { type: 'string' },
          text: { type: 'string' },
          applied: { type: 'boolean' },
          tolerant: { type: 'boolean' },
          line: { type: 'number' },
          sha256: { type: 'string' },
          current_span: { type: 'string' },
          current_span_line: { type: 'number' },
          match_count: { type: 'number' },
        },
        required: ['status', 'text', 'applied'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs,
    async execute(args, exec) {
      const session = exec?.agent?.session
      const shellPath = toShellPath(args.path)
      const target = shellPath
      const fail = (failureClass, status, text, extra = {}) => {
        const { notice, count } = trackFailure(session, { failureClass, target })
        return { status, applied: false, text: `${text}${notice}`, repeat_count: count, ...extra }
      }
      const succeed = (payload) => {
        // A success clears the family, so a later unrelated failure starts at
        // one rather than inheriting an old count.
        for (const failureClass of [FAILURE_CLASS.editConflict, FAILURE_CLASS.editAmbiguous, FAILURE_CLASS.editStale]) {
          clearFailure(session, failureSignature({ failureClass, target }))
        }
        return payload
      }

      const wantsSpan = typeof args.old_string === 'string'
      const wantsWhole = typeof args.content === 'string'
      if (wantsSpan === wantsWhole) {
        throw new Error('edit_apply needs either old_string + new_string, or content — not both and not neither')
      }
      if (wantsSpan && typeof args.new_string !== 'string') {
        throw new Error('edit_apply needs new_string alongside old_string')
      }

      const read = await run(readCommand(shellPath, maxFileBytes), exec)
      if (read.exitCode !== 0) {
        return fail(FAILURE_CLASS.readFailure, 'missing', `cannot read ${args.path}: ${read.stderr.trim() || `exit ${read.exitCode}`}`)
      }
      const [header, ...rest] = read.stdout.split('\n')
      if (header.trim() === 'MISSING') {
        return fail(FAILURE_CLASS.readFailure, 'missing', `${args.path} does not exist`)
      }
      if (header.trim().startsWith('TOO_LARGE')) {
        return fail(FAILURE_CLASS.readFailure, 'too_large', `${args.path} is larger than the ${maxFileBytes}-byte edit limit; change it with a scripted transformation instead`)
      }
      const content = Buffer.from(rest.join('').trim(), 'base64').toString('utf8')
      const currentSha = createDigest(content)

      if (typeof args.expected_sha256 === 'string' && args.expected_sha256 !== currentSha) {
        return fail(FAILURE_CLASS.editStale, 'stale',
          `${args.path} changed since it was read (now ${currentSha}). Rebuild the patch against current content.`,
          { sha256: currentSha })
      }

      let start
      let end
      let replacement
      let tolerant = false

      if (wantsWhole) {
        if (args.content === content) {
          return succeed({ status: 'unchanged', applied: false, text: `${args.path} already has this content`, sha256: currentSha })
        }
        start = 0
        end = Buffer.byteLength(content, 'utf8')
        replacement = args.content
      } else {
        if (args.old_string === args.new_string) {
          return succeed({ status: 'unchanged', applied: false, text: 'old_string and new_string are identical', sha256: currentSha })
        }
        const found = locate(content, args.old_string)
        if (found.kind === 'ambiguous') {
          const count = found.offsets.length
          return fail(FAILURE_CLASS.editAmbiguous, 'ambiguous',
            `old_string matches ${count > 0 ? count : 'several'} places in ${args.path}; extend it with surrounding lines`,
            { match_count: count })
        }
        if (found.kind === 'missing') {
          const near = nearestCandidate(content, args.old_string)
          return fail(FAILURE_CLASS.editConflict, 'conflict',
            near === undefined
              ? `old_string is not in ${args.path}, and none of its lines appear there. Read the file before editing it.`
              : `old_string is not in ${args.path}. Current text near the closest matching line (from line ${near.firstLine}):\n${near.text}`,
            near === undefined ? {} : { current_span: near.text, current_span_line: near.firstLine })
        }
        tolerant = found.kind === 'tolerant'
        // Offsets from `locate` index the decoded string; the splice needs bytes.
        start = Buffer.byteLength(content.slice(0, found.start), 'utf8')
        end = Buffer.byteLength(content.slice(0, found.end), 'utf8')
        replacement = args.new_string
      }

      const expected = content.slice(0, byteToCharIndex(content, start)) + replacement + content.slice(byteToCharIndex(content, end))
      const expectedSha = createDigest(expected)
      const commands = writeCommands({
        shellPath,
        start,
        end,
        replacementB64: Buffer.from(replacement, 'utf8').toString('base64'),
        digest: expectedSha,
      })

      let digestOutput = ''
      for (const command of commands) {
        const step = await run(command, exec)
        if (step.exitCode !== 0) {
          return fail(FAILURE_CLASS.writeFailure, 'write_failure',
            `writing ${args.path} failed: ${step.stderr.trim() || `exit ${step.exitCode}`}. The original file was left unchanged.`)
        }
        digestOutput = step.stdout
      }

      const observed = digestOutput.trim().split('\n').pop()?.trim() ?? ''
      if (observed !== expectedSha) {
        return fail(FAILURE_CLASS.verifyFailure, 'verify_failure',
          `${args.path} was written but its digest does not match the intended content (expected ${expectedSha}, found ${observed}). Re-read the file before editing again.`,
          { sha256: observed })
      }

      const line = lineAt(Buffer.from(content, 'utf8'), start)
      return succeed({
        status: 'applied',
        applied: true,
        tolerant,
        line,
        sha256: expectedSha,
        text: `applied to ${args.path} at line ${line}${tolerant ? ' (matched after normalising line endings/trailing whitespace)' : ''}; verified by digest`,
      })
    },
  })
}

/** Byte offset -> character index in a decoded string. */
function byteToCharIndex(content, byteOffset) {
  if (byteOffset <= 0) return 0
  let bytes = 0
  for (let index = 0; index < content.length; index += 1) {
    if (bytes >= byteOffset) return index
    bytes += Buffer.byteLength(content[index], 'utf8')
  }
  return content.length
}

/** sha256 of a UTF-8 string, matching `sha256sum` over the same bytes. */
function createDigest(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

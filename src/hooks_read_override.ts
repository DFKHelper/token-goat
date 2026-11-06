/** The explicit size overrides a host's Read tool takes, and the escalation of a repeated large-file refusal. Claude Code's Read takes `allow_large` (read a text file past the usual size limits) and `pages` (a PDF page range, at most 20 pages per request); no other host's Read schema is cited here, so every override is honored only when the payload came through the Claude harness. */

import * as fs from 'node:fs'

import { detectHarness, hasClaudeCodeEnvSignal } from './bridges/registry.js'
import { ENV_KEYS } from './constants.js'
import { quotedArg } from './hint_suggestion_guard.js'
import { TXT_WINDOW_LINES, PDF_PAGES_MAX, redactedLineView, textLineBounds, textLineStarts, type FileTypeHost } from './hints/file_type_handler.js'
import { fenceUntrustedFileContent } from './injection_scan.js'
import type { HookEvent } from './hook_registry.js'
import { readRequestedSliceWindow } from './hooks_read_slice.js'
import { getCompactedAt, markHintShown, wasHintShown } from './session.js'
import { isNonTextAsset } from './asset_extensions.js'
import { foldPath } from './util.js'

/** Bytes of file an escalated deny inlines: under half of the smallest text deny threshold (svg, 8,000), so the window it names next is never refused by the gate that refused the first read. */
const ESCALATED_WINDOW_BYTES = 4000

/** Bytes read from a file that would otherwise be let through on allow_large, to look for a NUL byte. */
const LARGE_FILE_PROBE_BYTES = 8192

const PAGES_RE = /^(\d+)(?:-(\d+))?$/

/** `_tg_harness` is 'claude' for every harness relay.ts does not map, so detectHarness() is what pins a Read to Claude Code (the same two-part test hooks_bash.ts uses); the hook server answers under the caller's own environment, so it sees the same variables here. detectHarness() also answers 'claudecode' from a bare `ANTHROPIC_API_KEY`, which any unmapped host can carry, so a Read is pinned to Claude Code only by the explicit `TOKEN_GOAT_HARNESS_OVERRIDE=claudecode` or by hasClaudeCodeEnvSignal(). */
function isClaudeRead(event: HookEvent): boolean {
  return event.toolName === 'Read' && event.raw['_tg_harness'] === 'claude' && detectHarness() === 'claudecode' && ((process.env[ENV_KEYS.HARNESS_OVERRIDE] ?? '').toLowerCase().trim() === 'claudecode' || hasClaudeCodeEnvSignal())
}

/** True when the first LARGE_FILE_PROBE_BYTES of the file hold no NUL byte; an unreadable file counts as binary so its deny stays. */
function leadingBytesHaveNoNul(filePath: string): boolean {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(LARGE_FILE_PROBE_BYTES)
    const n = fs.readSync(fd, buf, 0, LARGE_FILE_PROBE_BYTES, 0)
    return !buf.subarray(0, n).includes(0)
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // the descriptor is gone with the process either way
      }
    }
  }
}

/** What the file-type handlers may say about this host's Read. */
export function fileTypeHost(event: HookEvent): FileTypeHost {
  return { readTakesPages: isClaudeRead(event) }
}

/** Whether a `pages` value is a bounded range Claude Code's Read accepts ("3", "1-5"): 1-based, ascending, at most PDF_PAGES_MAX pages. */
export function isBoundedPagesRange(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const m = PAGES_RE.exec(value.trim())
  if (m === null) return false
  const start = Number(m[1])
  const end = m[2] === undefined ? start : Number(m[2])
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start && end - start + 1 <= PDF_PAGES_MAX
}

/** True when the caller explicitly asked for the read the file-type deny would refuse: `allow_large: true` on a text file, or a bounded `pages` range on a PDF; a text file with a NUL byte in its first LARGE_FILE_PROBE_BYTES keeps its deny. Both are the model's own override of the size gate, so the deny does not fire again for that call. A read without one is untouched. */
export function readOverridesFileTypeDeny(event: HookEvent, ext: string, isTextType: boolean, onDisk: string): boolean {
  if (!isClaudeRead(event)) return false
  if (ext === 'pdf') return isBoundedPagesRange(event.toolInput['pages'])
  return isTextType && event.toolInput['allow_large'] === true && leadingBytesHaveNoNul(onDisk)
}

/** True when a Claude Code Read of a file no file-type handler claims carries `allow_large: true` and the file is not a known non-text asset (src/asset_extensions.ts): the model's own override of the very-large-file deny. A binary asset keeps its deny, and so does every other host. */
export function readOverridesLargeFileDeny(event: HookEvent, filePath: string, onDisk: string): boolean {
  return isClaudeRead(event) && event.toolInput['allow_large'] === true && !isNonTextAsset(filePath) && leadingBytesHaveNoNul(onDisk)
}

/** The text a repeated refusal can inline: the file's bytes, or only its first TEXT_PREFIX_PROBE_BYTES when the file is too large to scan (`complete` false). */
export interface EscalationText {
  bytes: Buffer
  complete: boolean
}

/** The first `maxBytes` of `file`, empty when it cannot be read (best-effort, like the scan this stands in for). */
export function readFilePrefix(file: string, maxBytes: number): Buffer {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(maxBytes)
    return buf.subarray(0, fs.readSync(fd, buf, 0, maxBytes, 0))
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // best-effort
      }
    }
  }
}

interface EscalatedWindow {
  count: number
  body: string
  /** Set when the window ends inside its last line: that line's number, where the cut fell (file byte offset), where the line's text ends, and whether the line runs past the bytes held. */
  cut: { line: number; start: number; at: number; end: number; open: boolean } | null
}

/** Up to TXT_WINDOW_LINES lines from line `first` (1-based) that fit `byteBudget`, counting each line's real terminator. A first line over the budget is cut at it (never inside a code point) and reported in `cut`; a later line over the budget starts the next window instead. */
function takeWindow(buf: Buffer, starts: readonly number[], usable: number, first: number, openLast: boolean, byteBudget: number): EscalatedWindow {
  const parts: string[] = []
  let bytes = 0
  for (let i = first - 1; i < usable && parts.length < TXT_WINDOW_LINES; i++) {
    const { start, end, next } = textLineBounds(buf, starts, i)
    if (end - start > byteBudget) {
      if (parts.length > 0) break
      let at = start + byteBudget
      while (at > start && ((buf[at] ?? 0) & 0xc0) === 0x80) at--
      return { count: 1, body: buf.subarray(start, at).toString('utf8'), cut: { line: i + 1, start, at, end, open: openLast && i === usable - 1 } }
    }
    if (parts.length > 0 && bytes + (next - start) > byteBudget) break
    parts.push(buf.subarray(start, end).toString('utf8'))
    bytes += next - start
  }
  return { count: parts.length, body: parts.join('\n'), cut: null }
}

/** The window's text with every secret in the held buffer redacted before the window is cut from it (line breaks kept, so line numbers hold). Null when the window holds a NUL, when redaction changed the line structure or returned a non-string, when an unmatched private-key header is left, when the redacted window is over ESCALATED_WINDOW_BYTES, or when a cut line had anything redacted in it (a cut can leave a secret too short for its pattern). */
function shownWindow(buf: Buffer, starts: readonly number[], first: number, win: EscalatedWindow): string | null {
  if (win.body.includes('\0')) return null
  const view = redactedLineView(buf.toString('utf8'), starts.length)
  if (view === null) return null
  const redBuf = view.buf
  const redStarts = view.starts
  const lineAt = (b: Buffer, s: readonly number[], i: number): string => {
    const { start, end } = textLineBounds(b, s, i)
    return b.subarray(start, end).toString('utf8')
  }
  if (win.cut !== null) {
    const i = win.cut.line - 1
    return lineAt(redBuf, redStarts, i) === lineAt(buf, starts, i) ? win.body : null
  }
  const shown = Array.from({ length: win.count }, (_, k) => lineAt(redBuf, redStarts, first - 1 + k)).join('\n')
  // Placeholders can be longer than the text they replace; the window was sized on the original bytes, so what is shown must fit the same cap or nothing is shown (cutting lines here would break the line numbers and the next-window command).
  return Buffer.byteLength(shown, 'utf8') > ESCALATED_WINDOW_BYTES ? null : shown
}

/** The deny a repeated refusal of the same file becomes: a bounded window of the file inlined in place of the refusal, and the next window to ask for. The first refusal is booked, and every one after it (whatever offset, limit or allow_large the retry carried) gets the window. Lines split on CRLF, LF and lone CR. A line cut for size says so and names the dd command for the rest of it; the end of the file is claimed only when every byte has been shown. Repeating the same request returns the same window by design, so the text names the next window's command instead of counting on a breaker. Null for the first refusal, for a file with nothing to inline, for a non-text asset or bytes holding a NUL in their first LARGE_FILE_PROBE_BYTES (whatever the extension), when redaction or fencing fails or leaves a private-key header unmatched, a NUL in the window, a cut line with a redaction in it, and for an offset past the bytes held of a file too large to scan. */
export function escalateRepeatedFileTypeDeny(event: HookEvent, filePath: string, text: EscalationText): string | null {
  const byteBudget = ESCALATED_WINDOW_BYTES
  const key = 'file-type-deny:' + getCompactedAt() + ':' + foldPath(filePath)
  if (!wasHintShown(key)) {
    markHintShown(key)
    return null
  }
  const buf = text.bytes
  if (buf.length === 0 || isNonTextAsset(filePath) || buf.subarray(0, LARGE_FILE_PROBE_BYTES).includes(0)) return null
  const starts = textLineStarts(buf)
  // Without the whole file, the last line held may be cut off by the end of the bytes: only a lone line is kept, as a cut one.
  const openLast = !text.complete && starts.length === 1
  const usable = text.complete || openLast ? starts.length : starts.length - 1
  const requested = Math.max(1, readRequestedSliceWindow(event).offset ?? 1)
  if (!text.complete && requested > usable) return null
  const first = Math.min(requested, usable)
  const win = takeWindow(buf, starts, usable, first, openLast, byteBudget)
  const last = first + win.count - 1
  const more = last < usable || !text.complete
  const nextLimit = last < usable ? Math.max(1, takeWindow(buf, starts, usable, last + 1, openLast, byteBudget).count) : win.count
  const tgRead = `token-goat read ${quotedArg(`${filePath}@${last + 1}-${last + nextLimit}`)}`
  const next = isClaudeRead(event) ? `Read with offset ${last + 1} and limit ${nextLimit}, or \`${tgRead}\`` : `\`${tgRead}\``
  const total = text.complete ? ` of ${starts.length.toLocaleString()}` : ''
  const head = `This file was refused before, so lines ${first}-${last}${total} are inlined here in place of the full file:`
  // Offsets, line counts and the commands below come from the original bytes; the printed text comes from the redacted whole buffer, so a secret the window cut in two is still seen whole, and a redaction failure never falls back to the unredacted text.
  let fenced: string
  try {
    const shown = shownWindow(buf, starts, first, win)
    if (shown === null) return null
    fenced = fenceUntrustedFileContent(shown)
    if (typeof fenced !== 'string') return null
  } catch {
    return null
  }
  const body = `${head}\n${fenced}`
  const again = 'Repeating the same request returns this same window.'
  if (win.cut === null) {
    return more ? `${body}\nNext window: ${next}. ${again}` : `${body}\nThat is the end of the file.`
  }
  const { line, start, at, end, open } = win.cut
  const rest = open ? byteBudget : Math.min(end - at, byteBudget)
  const length = open ? `longer than ${byteBudget.toLocaleString()} bytes` : `${(end - start).toLocaleString()} bytes long`
  const dd = `dd if=${quotedArg(filePath)} bs=1 skip=${at} count=${rest} status=none`
  const further = open || end - at > byteBudget ? ` (then skip=${at + rest} for the piece after it)` : ''
  const after = more ? ` The window after that line: ${next}.` : ' It is the last line of the file.'
  return `${body}\nLine ${line} is ${length} and was cut at ${byteBudget.toLocaleString()} bytes. The rest of it: \`${dd}\`${further}.${after} ${again}`
}

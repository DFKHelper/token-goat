import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fingerprintContent } from './fingerprint.js'
import { redactSerializedJson } from './secret_redact.js'
import { ensureSessionDirectory, sessionSidecarPath } from './session_store.js'
import { atomicWriteText, withFileLock } from './util.js'

/** The line extents a successful `token-goat read` or `token-goat section` call handed the model, so the session's served-range ledger counts them like a sliced Read does. Only `read` and `section` name their file in the command; `symbol NAME` does not, so it has no extent to place. */

export interface ServedExtent {
  filePath: string
  start: number
  end: number
}

export interface SectionReadEvidence {
  filePath: string
  target: string
  start: number
  end: number
  sourceSha: string
}

export interface SectionReadReceipt {
  nonce: string
  pathSha: string
  targetSha: string
  outputSha: string
  sourceSha: string
  start: number
  end: number
}

const SECTION_READ_RECEIPTS_SUFFIX = '.section-read-receipts'
const SECTION_READ_RECEIPTS_LOCK_SUFFIX = '.section-read-receipts.lock'
// limit: retain the newest 32 unconsumed receipts; revisit-when: a valid receipt is evicted before its PostToolUse event arrives.
const MAX_PENDING_SECTION_READ_RECEIPTS = 32
const SECTION_READ_RECEIPT_NONCE_RE = /^[0-9a-f]{32}$/
const SHA256_RE = /^[0-9a-f]{64}$/

export function createSectionReadReceiptNonce(): string {
  return randomBytes(16).toString('hex')
}

export function sectionReadReceiptSessionKey(sessionId: string): string {
  return fingerprintContent(sessionId)
}

export function addSectionReadReceipt(command: string): string {
  if (!command.startsWith('token-goat section ')) return command
  const sessionId = process.env['CLAUDE_CODE_SESSION_ID']
  const sessionKey =
    sessionId !== undefined && sessionId !== '' ? ` --_section-read-session-key ${sectionReadReceiptSessionKey(sessionId)}` : ''
  return `${command} --_section-read-receipt ${createSectionReadReceiptNonce()}${sessionKey}`
}

export function isSectionReadReceiptNonce(value: string): boolean {
  return SECTION_READ_RECEIPT_NONCE_RE.test(value)
}

export function isSectionReadReceiptSessionKey(value: string): boolean {
  return SHA256_RE.test(value)
}

function isSectionReadReceipt(value: unknown): value is SectionReadReceipt {
  if (typeof value !== 'object' || value === null) return false
  const receipt = value as Record<string, unknown>
  return (
    typeof receipt['nonce'] === 'string' &&
    isSectionReadReceiptNonce(receipt['nonce']) &&
    typeof receipt['pathSha'] === 'string' &&
    SHA256_RE.test(receipt['pathSha']) &&
    typeof receipt['targetSha'] === 'string' &&
    SHA256_RE.test(receipt['targetSha']) &&
    typeof receipt['outputSha'] === 'string' &&
    SHA256_RE.test(receipt['outputSha']) &&
    typeof receipt['sourceSha'] === 'string' &&
    SHA256_RE.test(receipt['sourceSha']) &&
    Number.isSafeInteger(receipt['start']) &&
    (receipt['start'] as number) > 0 &&
    Number.isSafeInteger(receipt['end']) &&
    (receipt['end'] as number) >= (receipt['start'] as number)
  )
}

function readSectionReadReceipts(filePath: string): SectionReadReceipt[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isSectionReadReceipt) : []
  } catch {
    return []
  }
}

function withSectionReadReceipts<T>(sessionId: string, work: (receipts: SectionReadReceipt[]) => T): T | undefined {
  const filePath = sessionSidecarPath(sessionId, SECTION_READ_RECEIPTS_SUFFIX)
  const lockPath = sessionSidecarPath(sessionId, SECTION_READ_RECEIPTS_LOCK_SUFFIX)
  if (filePath === null || lockPath === null) return undefined
  try {
    ensureSessionDirectory(sessionId)
    return withFileLock(
      lockPath,
      () => {
        const receipts = readSectionReadReceipts(filePath)
        const before = JSON.stringify(receipts)
        const result = work(receipts)
        const after = JSON.stringify(receipts.slice(-MAX_PENDING_SECTION_READ_RECEIPTS))
        if (after !== before) atomicWriteText(filePath, redactSerializedJson(after).text)
        return result
      },
      { waitMs: 200 },
    )
  } catch {
    return undefined
  }
}

export function writeSectionReadReceipt(
  sessionId: string,
  nonce: string,
  evidence: SectionReadEvidence,
  output: string,
): boolean {
  if (
    !isSectionReadReceiptNonce(nonce) ||
    evidence.filePath.length === 0 ||
    evidence.target.length === 0 ||
    !SHA256_RE.test(evidence.sourceSha) ||
    !Number.isSafeInteger(evidence.start) ||
    evidence.start < 1 ||
    !Number.isSafeInteger(evidence.end) ||
    evidence.end < evidence.start
  ) {
    return false
  }
  const result = withSectionReadReceipts(sessionId, (receipts) => {
    if (receipts.some((receipt) => receipt.nonce === nonce)) return false
    receipts.push({
      nonce,
      pathSha: fingerprintContent(resolve(evidence.filePath)),
      targetSha: fingerprintContent(evidence.target),
      outputSha: fingerprintContent(output),
      sourceSha: evidence.sourceSha,
      start: evidence.start,
      end: evidence.end,
    })
    return true
  })
  return result === true
}

export function takeSectionReadReceipt(sessionId: string, nonce: string): SectionReadReceipt | null {
  if (!isSectionReadReceiptNonce(nonce)) return null
  const result = withSectionReadReceipts(sessionId, (receipts) => {
    const matches = receipts.filter((receipt) => receipt.nonce === nonce)
    if (matches.length === 0) return null
    for (let i = receipts.length - 1; i >= 0; i--) {
      if (receipts[i]!.nonce === nonce) receipts.splice(i, 1)
    }
    return matches.length === 1 ? matches[0]! : null
  })
  return result ?? null
}

export function sectionReadReceiptMatches(
  receipt: SectionReadReceipt,
  filePath: string,
  target: string,
  output: string,
): boolean {
  return (
    receipt.pathSha === fingerprintContent(resolve(filePath)) &&
    receipt.targetSha === fingerprintContent(target) &&
    receipt.outputSha === fingerprintContent(output)
  )
}

/** Flags that stop the call printing the whole symbol or section, so its extent no longer says what was shown: a cut (`--grep`, `--max-lines`, `--head`), another output (`--json`/`-j`, `--stats`, `--list`, which prints headings), or usage text (`--help`/`-h`). Any short cluster holding `j` or `h` counts, which only errs toward recording nothing. */
const NARROWING_FLAG = /\s(?:--(?:grep|max-lines|head|tail|section|stats|json|list|help)\b|-[A-Za-gik-z]*[jh])/

/** The `@N` / `@N-M` suffix of `spec`, or null. A `::` before the suffix means the `@` anchors a symbol line, not a range. */
function rangeSuffix(spec: string): { file: string; start: number; end: number } | null {
  const m = /^(.+)@(\d+)(?:-(\d+))?$/.exec(spec)
  if (m === null || m[1]!.includes('::')) return null
  const start = parseInt(m[2]!, 10)
  return { file: m[1]!, start, end: m[3] !== undefined ? parseInt(m[3], 10) : start }
}

/** An unquoted pipe, redirect, `;` or `&` (the character class of WHOLE_FILE_READ's operand), after which the printed text is cut or sent elsewhere. */
const SHELL_OPERATOR = /[|<>;&]/

/** A trailing stderr-only redirect (`2>/dev/null`, `2>&1`, PowerShell's `2>$null`): it hides nothing the model sees on stdout, which is what a read's text is. A stdout redirect (`>/dev/null`, `1>`) is not one. */
const STDERR_ONLY_TAIL = /(?:[ \t]+2>[ \t]*(?:\/dev\/null|&1|\$null))+[ \t]*$/

/** The extents served by `token-goat <sub> <spec>` as `extractTgSurgicalRead` classified it (`spec` holds the resolved file path). Best-effort: an unresolvable or ambiguous spec yields nothing, and so does a command whose flags narrow the output. The resolvers load on demand because this runs on the hook path. */
export async function servedExtents(sub: string, spec: string, cmd: string, projectRoot: string | null): Promise<ServedExtent[]> {
  if (NARROWING_FLAG.test(cmd)) return []
  const { maskQuotedSpans } = await import('./tool_filters/helpers.js')
  if (SHELL_OPERATOR.test(maskQuotedSpans(cmd).replace(STDERR_ONLY_TAIL, ''))) return []
  if (sub === 'read') {
    const range = rangeSuffix(spec)
    if (range !== null) return range.end >= range.start ? [{ filePath: range.file, start: range.start, end: range.end }] : []
  }
  const { parseColonLineRange, parseReadSpec, resolveSymbolSpec } = await import('./read_spec.js')
  const { file, symbol } = parseReadSpec(spec)
  if (symbol === undefined || symbol === '') return []
  if (sub === 'section') {
    const [{ readSection }, { readFileText }] = await Promise.all([import('./section_reader.js'), import('./read_commands.js')])
    const hit = readSection(file, symbol, readFileText)
    return hit !== null && hit.occurrences === undefined ? [{ filePath: file, start: hit.lineStart, end: hit.lineEnd }] : []
  }
  if (sub !== 'read') return []
  const colonRange = parseColonLineRange(symbol)
  if (colonRange !== null) return [{ filePath: file, start: colonRange.start, end: colonRange.end }]
  const extents: ServedExtent[] = []
  for (const name of symbol.split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
    const resolution = resolveSymbolSpec(`${file}::${name}`, undefined, projectRoot ?? undefined)
    if (resolution.kind === 'ok') extents.push({ filePath: resolution.entry.filePath, start: resolution.entry.lineStart, end: resolution.entry.lineEnd })
  }
  return extents
}

/** A bare `token-goat read <file>`: one spec, no flag, pipe or redirect, so the call printed the file's whole text. */
const WHOLE_FILE_READ = /^(?:token-goat|tg)\s+read\s+(?:"[^"]+"|'[^']+'|[^\s"'|<>;&-][^\s|<>;&]*)\s*$/

/** True when `cmd` is a bare `token-goat read` of `spec`'s file with nothing after the file: `spec` is the resolved path alone (no `::symbol`, no `@range`) and no flag narrows the output. Such a call counts as a full read of the file. */
export function isWholeFileRead(sub: string, spec: string, filePath: string, cmd: string): boolean {
  return sub === 'read' && spec === filePath && WHOLE_FILE_READ.test(cmd.trim())
}

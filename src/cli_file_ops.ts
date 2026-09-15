import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { CliError, out } from './cli.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { buildLineDiff } from './hooks_read.js'
import { fingerprintContent } from './fingerprint.js'
import {
  computeFileFingerprint,
  resolveSymbolMatch,
  symbolNamesInFile,
  upsertNote,
  WHOLE_FILE_NOTE_SYMBOL,
} from './notes.js'
import { resolveIndexPath } from './paths.js'
import {
  AMBIGUOUS_HEADING_LIMIT,
  didYouMean,
  filterSimilarHeadings,
  healStaleIndex,
  listSections,
  rankSimilarNames,
  readSection,
} from './read_commands.js'
import { recordStat } from './stats.js'
import {
  countNoun,
  decodeSource,
  detectSourceEncoding,
  encodeSource,
  isWindows,
  sleepSync,
  withRetryOnLock,
} from './util.js'

function atomicWriteBuffer(dest: string, data: Buffer): void {
  try {
    if (fs.statSync(dest).isDirectory()) {
      const e = Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${dest}'`), { code: 'EISDIR', path: dest }) as NodeJS.ErrnoException
      throw e
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const rnd = randomBytes(4).toString('hex')
  const tmp = path.join(path.dirname(path.resolve(dest)), `.tmp.${process.pid}.${rnd}`)
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 })
    try {
      const destMode = fs.statSync(dest).mode
      fs.chmodSync(tmp, destMode)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    withRetryOnLock(() => {
      try {
        fs.renameSync(tmp, dest)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
          fs.copyFileSync(tmp, dest)
          try { fs.unlinkSync(tmp) } catch (ue) {
            process.stderr.write(`token-goat write-file: warning: could not remove temp file ${tmp}: ${(ue as NodeJS.ErrnoException).message}\n`)
          }
          return
        }
        throw e
      }
    })
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore cleanup failure */ }
    throw e
  }
}

function mapFsError(e: unknown, src?: string, dest?: string, srcLabel = 'source'): never {
  const fe = e as NodeJS.ErrnoException
  if (fe.code === 'ENOENT') {
    const errPath = fe.path ?? ''
    const isSource = src !== undefined && path.resolve(errPath) === path.resolve(src)
    if (isSource) throw new CliError(`${/\bfile$/i.test(srcLabel) ? srcLabel : `${srcLabel} file`} not found: ${src}`)
    const destDir = dest ? path.dirname(path.resolve(dest)) : path.dirname(path.resolve(errPath || '.'))
    throw new CliError(`destination directory does not exist: ${destDir}`)
  }
  if (fe.code === 'ENOTDIR') {
    if (src !== undefined && dest === undefined) {
      throw new CliError(`source path contains a file where a directory was expected: ${src}`)
    }
    throw new CliError(`destination path contains a file where a directory was expected: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EISDIR') {
    const errPath = fe.path ?? ''
    const isSource = src !== undefined && (errPath === '' || path.resolve(errPath) === path.resolve(src))
    if (isSource) throw new CliError(`source is a directory, not a file: ${src}`)
    throw new CliError(`destination is a directory, not a file: ${dest ?? (errPath || '(unknown)')}`)
  }
  if (fe.code === 'EACCES' || fe.code === 'EPERM') {
    if (src !== undefined && dest === undefined) {
      throw new CliError(`permission denied reading: ${src}`)
    }
    throw new CliError(`permission denied writing to: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EROFS') {
    throw new CliError(`filesystem is read-only: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ENOSPC') {
    throw new CliError(`no space left on device writing to: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ELOOP') {
    throw new CliError(`too many levels of symbolic links resolving: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ENAMETOOLONG') {
    throw new CliError(`path is too long: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EMFILE' || fe.code === 'ENFILE') {
    throw new CliError(`too many open files; close other processes or raise the file-descriptor limit and retry`)
  }
  if (fe.code === 'ETXTBSY') {
    throw new CliError(`file is in use by a running process: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EDQUOT') {
    throw new CliError(`disk quota exceeded writing to: ${dest ?? fe.path ?? ''}`)
  }
  throw e
}

const WIN_RESERVED = new Set([
  'CON','PRN','AUX','NUL',
  'COM0','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT0','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9',
  'CONIN$','CONOUT$',
])

function validateWritablePath(dest: string, label: string): void {
  if (!dest || !dest.trim()) {
    throw new CliError(`${label} path cannot be empty`)
  }
  if (dest.includes('\0')) {
    throw new CliError(`${label} path contains a null byte`)
  }
  if (isWindows()) {
    const base = path.basename(dest)
    const stem = base.replace(/\.[^.]*$/, '').toUpperCase()
    if (WIN_RESERVED.has(stem)) {
      throw new CliError(`${label} '${base}' is a reserved Windows device name`)
    }
    if (base.endsWith('.') || base.endsWith(' ')) {
      throw new CliError(`${label} filename '${base}' ends with '${base.slice(-1)}' — Windows NTFS silently strips trailing dots and spaces, which would clobber a different file`)
    }
  }
}

function parseMaxStdinMB(): number {
  const raw = process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? '512'
  const maxMB = parseInt(raw, 10)
  if (!Number.isFinite(maxMB) || maxMB <= 0) {
    throw new CliError(`TOKEN_GOAT_MAX_STDIN_MB must be a positive integer; got '${raw}'`)
  }
  return maxMB
}

function readFileBoundedRaw(filePath: string, label: string, allowStdIn = false): Buffer {
  if (!filePath || !filePath.trim()) {
    throw new CliError(`${label} path cannot be empty`)
  }
  if (filePath.includes('\0')) {
    throw new CliError(`${label} path contains a null byte`)
  }
  if (!allowStdIn && !isWindows() && /^\/dev\/(stdin|fd\/0)$|^\/proc\/self\/fd\/0$/.test(filePath) && process.stdin.isTTY) {
    const altLabel = label.endsWith('-from') ? label.replace('-from', '-b64') : 'a regular file path'
    throw new CliError(`${label} ${filePath} requires piped input; use ${altLabel} for interactive use`)
  }
  try {
    const st = fs.statSync(filePath)
    if (st.isFIFO() || st.isSocket()) {
      throw new CliError(`${label} '${filePath}' is a special file (FIFO or socket) — only regular files are supported`)
    }
    const maxBytes = parseMaxStdinMB() * 1024 * 1024
    if (st.size > maxBytes) {
      throw new CliError(`${label} '${filePath}' exceeds size limit (${Math.round(st.size / 1024 / 1024)} MB); set TOKEN_GOAT_MAX_STDIN_MB to override`)
    }
    return fs.readFileSync(filePath)
  } catch (e) {
    if (e instanceof CliError) throw e
    mapFsError(e, filePath, undefined, label)
  }
}

function decodeBase64Buffer(payload: string, label: string): Buffer {
  const normalized = payload.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (payload !== '' && normalized === '') {
    throw new CliError(`${label} payload contains only whitespace — likely a shell expansion error; pass an empty string explicitly for a zero-byte file`)
  }
  const maxBytes = parseMaxStdinMB() * 1024 * 1024
  const decodedSize = Math.floor((normalized.replace(/=+$/, '').length * 3) / 4)
  if (decodedSize > maxBytes) {
    throw new CliError(`${label} payload would decode to ${Math.round(decodedSize / 1024 / 1024)} MB which exceeds size limit; set TOKEN_GOAT_MAX_STDIN_MB to override`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new CliError(`${label} payload contains non-base64 characters — check for shell expansion of $VAR or backticks`)
  }
  if (normalized.replace(/=+$/, '').length % 4 === 1) {
    throw new CliError(`${label} payload length is invalid (trailing single base64 character cannot decode to any bytes — payload is likely truncated)`)
  }
  return Buffer.from(normalized, 'base64')
}

export function cmdNoteAdd(file: string, opts: { symbol?: string; contentFrom?: string; contentB64?: string }): void {
  if (!file || !file.trim()) {
    throw new CliError('file path cannot be empty')
  }

  const usingFrom = opts.contentFrom !== undefined
  const usingB64 = opts.contentB64 !== undefined
  if (usingFrom && usingB64) {
    throw new CliError('cannot mix --content-from with --content-b64')
  }
  if (!usingFrom && !usingB64) {
    throw new CliError('must provide either --content-from or --content-b64')
  }
  const contentBytes = usingFrom
    ? readFileBoundedRaw(opts.contentFrom!, '--content-from')
    : decodeBase64Buffer(opts.contentB64!, '--content-b64')
  if (contentBytes.length === 0) {
    throw new CliError('note content cannot be empty')
  }
  if (Buffer.compare(Buffer.from(contentBytes.toString('utf8'), 'utf8'), contentBytes) !== 0) {
    throw new CliError('note content must be valid UTF-8 text')
  }

  const resolvedPath = resolveIndexPath(file)
  if (!fs.existsSync(resolvedPath)) {
    throw new CliError(`File not found: '${resolvedPath}'`)
  }
  healStaleIndex(resolvedPath)

  let symbol = WHOLE_FILE_NOTE_SYMBOL
  let fingerprint: string
  if (opts.symbol !== undefined) {
    const match = resolveSymbolMatch(resolvedPath, opts.symbol)
    if (match === null) {
      const messages = [`No symbol named '${opts.symbol}' is indexed in '${file}'`]
      const allNames = symbolNamesInFile(resolvedPath)
      const available = rankSimilarNames(allNames, opts.symbol)
      if (available.length > 0) messages.push(didYouMean(available))
      else if (allNames.length > 0) messages.push(`Try: token-goat outline ${file}`)
      throw new CliError(messages.join('\n'))
    }
    symbol = opts.symbol
    fingerprint = fingerprintContent(match.body)
  } else {
    fingerprint = computeFileFingerprint(resolvedPath)
  }

  upsertNote(resolvedPath, symbol, contentBytes.toString('utf8'), fingerprint)
  const target = opts.symbol !== undefined ? `${file}::${opts.symbol}` : file
  out(`Note saved: ${target} (fingerprint ${fingerprint.slice(0, 12)})`)
  recordStat('note_write')
}

export function cmdWriteFile(dest: string, opts: { from?: string; b64?: string }): Promise<void> | void {
  validateWritablePath(dest, 'destination')
  if (opts.from !== undefined && opts.b64 !== undefined) {
    throw new CliError('cannot use --from and --b64 together')
  }
  if (opts.from !== undefined) {
    const buf = readFileBoundedRaw(opts.from, '--from')
    try {
      atomicWriteBuffer(dest, buf)
    } catch (e) {
      mapFsError(e, opts.from, dest)
    }
    enqueueDirtyPathSafe(dest)
    return
  }
  if (opts.b64 !== undefined) {
    const buf = decodeBase64Buffer(opts.b64, '--b64')
    try {
      atomicWriteBuffer(dest, buf)
    } catch (e) {
      mapFsError(e, undefined, dest)
    }
    enqueueDirtyPathSafe(dest)
    return
  }
  if (process.stdin.isTTY) {
    throw new CliError('provide content via --from <file>, --b64 <payload>, or piped to stdin')
  }
  return new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    const maxBytes = parseMaxStdinMB() * 1024 * 1024

    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        process.stdin.removeListener('end', onEnd)
        process.stdin.removeListener('error', onError)
        reject(new CliError(`piped stdin exceeds size limit (${Math.round(totalBytes / 1024 / 1024)} MB); set TOKEN_GOAT_MAX_STDIN_MB to override`))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      try { atomicWriteBuffer(dest, Buffer.concat(chunks)); enqueueDirtyPathSafe(dest); resolve() }
      catch (e) { try { mapFsError(e, undefined, dest) } catch (err) { reject(err) } }
    }
    const onError = (e: Error): void => {
      reject(new CliError(`failed reading stdin: ${e.message}`))
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
    process.stdin.resume()
  })
}

function diagnoseNearMiss(targetText: string, oldText: string): string | undefined {
  const oldWithoutTrailingNewline = oldText.replace(/\r?\n$/, '')
  if (oldWithoutTrailingNewline !== oldText && oldWithoutTrailingNewline !== '' && targetText.includes(oldWithoutTrailingNewline)) {
    return `a near-match exists that differs only by a trailing newline — --old-from/--old-b64 has a trailing newline that is not present at that point in the file; check the exact content`
  }
  const normalize = (s: string) => s.replace(/\r\n/g, '\n')
  const normalizedOld = normalize(oldText)
  const normalizedTarget = normalize(targetText)

  if (targetText !== oldText && normalizedTarget.includes(normalizedOld) && !targetText.includes(oldText)) {
    if (oldText.includes('\r\n') && !targetText.includes('\r\n')) {
      return `a near-match exists that differs only by line endings — --old-from/--old-b64 uses CRLF but the file uses LF at that location; check the exact content`
    }
    if (oldText.includes('\n') && !oldText.includes('\r\n') && targetText.includes('\r\n')) {
      return `a near-match exists that differs only by line endings — --old-from/--old-b64 uses LF but the file uses CRLF at that location; check the exact content`
    }
  }
  return undefined
}

function detectDominantEol(buf: Buffer): '\r\n' | '\n' {
  let crlf = 0
  let lfOnly = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > 0 && buf[i - 1] === 0x0d) crlf++
      else lfOnly++
    }
  }
  return crlf > lfOnly ? '\r\n' : '\n'
}

function convertEolTo(source: Buffer, eol: '\r\n' | '\n'): Buffer {
  const CR = 0x0d
  const LF = 0x0a
  const collapsed: number[] = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] === CR && source[i + 1] === LF) continue
    collapsed.push(source[i]!)
  }
  if (eol === '\n') return Buffer.from(collapsed)
  const expanded: number[] = []
  for (const b of collapsed) {
    if (b === LF) expanded.push(CR, LF)
    else expanded.push(b)
  }
  return Buffer.from(expanded)
}

function normalizeEolToMatch(source: Buffer, reference: Buffer): Buffer {
  return convertEolTo(source, detectDominantEol(reference))
}

function buildEolCollapsedView(buf: Buffer): { collapsed: Buffer; origStart: number[] } {
  const CR = 0x0d
  const LF = 0x0a
  const bytes: number[] = []
  const origStart: number[] = []
  let i = 0
  while (i < buf.length) {
    if (buf[i] === CR && buf[i + 1] === LF) {
      bytes.push(LF)
      origStart.push(i)
      i += 2
    } else {
      bytes.push(buf[i]!)
      origStart.push(i)
      i += 1
    }
  }
  origStart.push(buf.length)
  return { collapsed: Buffer.from(bytes), origStart }
}

function findEolCollapsedMatches(target: Buffer, old: Buffer): { start: number; end: number }[] {
  const { collapsed: oldCollapsed } = buildEolCollapsedView(old)
  if (oldCollapsed.length === 0) return []
  const { collapsed: targetCollapsed, origStart } = buildEolCollapsedView(target)
  const spans: { start: number; end: number }[] = []
  let cursor = 0
  while ((cursor = targetCollapsed.indexOf(oldCollapsed, cursor)) !== -1) {
    spans.push({ start: origStart[cursor]!, end: origStart[cursor + oldCollapsed.length]! })
    cursor += oldCollapsed.length
  }
  return spans
}

function localEolStyle(buf: Buffer, span: { start: number; end: number }, wholeFileFallback: Buffer): '\r\n' | '\n' {
  const slice = buf.subarray(span.start, span.end)
  let crlf = 0
  let lfOnly = 0
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0x0a) {
      if (i > 0 && slice[i - 1] === 0x0d) crlf++
      else lfOnly++
    }
  }
  if (crlf === 0 && lfOnly === 0) return detectDominantEol(wholeFileFallback)
  return crlf > lfOnly ? '\r\n' : '\n'
}

function writeReplacedBuffer(file: string, replacedBuf: Buffer, preWriteStat: fs.Stats | undefined): void {
  if (preWriteStat !== undefined) {
    const testDelayMs = Number(process.env['TOKEN_GOAT_TEST_REPLACE_DELAY_MS'] ?? '')
    if (Number.isFinite(testDelayMs) && testDelayMs > 0) {
      process.stderr.write('TOKEN_GOAT_TEST_REPLACE_DELAY_READY\n')
      const until = process.env['TOKEN_GOAT_TEST_REPLACE_DELAY_UNTIL']
      const deadline = Date.now() + testDelayMs
      if (until !== undefined && until !== '') {
        while (Date.now() < deadline && !fs.existsSync(until)) sleepSync(5)
      } else {
        sleepSync(testDelayMs)
      }
    }
    let preRenameStat: fs.Stats | undefined
    try {
      preRenameStat = fs.statSync(file)
    } catch {
      // Vanished between the read and the write
    }
    if (preRenameStat !== undefined && (preRenameStat.mtimeMs !== preWriteStat.mtimeMs || preRenameStat.size !== preWriteStat.size)) {
      throw new CliError(`${file} changed on disk while replace was running -- the file was modified concurrently, so the replace was NOT applied. Retry the replace.`)
    }
  }
  try {
    atomicWriteBuffer(file, replacedBuf)
  } catch (e) {
    mapFsError(e, undefined, file)
  }
  enqueueDirtyPathSafe(file)
}

const MAX_CLOSEST_MATCH_COMPARISONS = 2_000_000

function findClosestLineWindow(targetText: string, oldText: string): { lineStart: number; region: string } | undefined {
  const targetLines = targetText.split('\n')
  const oldLines = oldText.split('\n')
  const windowSize = oldLines.length
  if (windowSize === 0 || windowSize > targetLines.length) return undefined
  if ((targetLines.length - windowSize + 1) * windowSize > MAX_CLOSEST_MATCH_COMPARISONS) return undefined

  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i <= targetLines.length - windowSize; i++) {
    let score = 0
    for (let j = 0; j < windowSize; j++) {
      if (targetLines[i + j] === oldLines[j]) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  if (bestIdx === -1) return undefined
  return { lineStart: bestIdx + 1, region: targetLines.slice(bestIdx, bestIdx + windowSize).join('\n') }
}

export function cmdReplace(file: string, opts: { oldFrom?: string; newFrom?: string; oldB64?: string; newB64?: string; all?: boolean; normalizeNewlines?: boolean }): void {
  validateWritablePath(file, 'target file')

  const targetBuf = readFileBoundedRaw(file, 'target file', true)
  let preWriteStat: fs.Stats | undefined
  try {
    preWriteStat = fs.statSync(file)
  } catch {
    // If the file vanished
  }
  const usingFrom = opts.oldFrom !== undefined || opts.newFrom !== undefined
  const usingB64 = opts.oldB64 !== undefined || opts.newB64 !== undefined

  if (usingFrom && usingB64) {
    throw new CliError('cannot mix --old-from/--new-from with --old-b64/--new-b64')
  }
  if (!usingFrom && !usingB64) {
    throw new CliError('must provide either --old-from/--new-from or --old-b64/--new-b64')
  }
  if (usingFrom) {
    if (opts.oldFrom === undefined || opts.newFrom === undefined) {
      throw new CliError('must pass both --old-from and --new-from together')
    }
  } else {
    if (opts.oldB64 === undefined || opts.newB64 === undefined) {
      throw new CliError('must pass both --old-b64 and --new-b64 together')
    }
  }

  const oldBytes = usingFrom
    ? readFileBoundedRaw(opts.oldFrom!, '--old-from')
    : decodeBase64Buffer(opts.oldB64!, '--old-b64')
  const newBytes = usingFrom
    ? readFileBoundedRaw(opts.newFrom!, '--new-from')
    : decodeBase64Buffer(opts.newB64!, '--new-b64')

  const normalizedOldBytes = opts.normalizeNewlines === true ? normalizeEolToMatch(oldBytes, targetBuf) : oldBytes
  const normalizedNewBytes = opts.normalizeNewlines === true ? normalizeEolToMatch(newBytes, targetBuf) : newBytes

  if (normalizedOldBytes.length === 0) {
    throw new CliError('old string cannot be empty')
  }

  const matches: number[] = []
  let cursor = 0
  while ((cursor = targetBuf.indexOf(normalizedOldBytes, cursor)) !== -1) {
    matches.push(cursor)
    cursor += normalizedOldBytes.length
  }
  const occurrences = matches.length

  if (occurrences === 0) {
    const eolMatches = findEolCollapsedMatches(targetBuf, normalizedOldBytes)
    if (eolMatches.length === 1) {
      const span = eolMatches[0]!
      const healedNewBytes = convertEolTo(normalizedNewBytes, localEolStyle(targetBuf, span, targetBuf))
      const healedBuf = Buffer.concat([targetBuf.subarray(0, span.start), healedNewBytes, targetBuf.subarray(span.end)])
      writeReplacedBuffer(file, healedBuf, preWriteStat)
      out(`replaced 1 occurrence in ${file} (line-ending normalized to match the file at that location)`)
      return
    }
    if (eolMatches.length > 1) {
      throw new CliError(
        `old string not found in ${file} — ${eolMatches.length} near-matches exist that differ only by line endings; provide a more specific match`,
      )
    }
    const nearMiss = diagnoseNearMiss(targetBuf.toString('utf8'), normalizedOldBytes.toString('utf8'))
    if (nearMiss !== undefined) {
      throw new CliError(`old string not found in ${file} — ${nearMiss}`)
    }
    const closest = findClosestLineWindow(targetBuf.toString('utf8'), normalizedOldBytes.toString('utf8'))
    if (closest !== undefined) {
      const diff = buildLineDiff(closest.region, normalizedOldBytes.toString('utf8'), file)
      throw new CliError(
        `old string not found in ${file} — closest match at line ${closest.lineStart} (showing: what's actually there vs. what --old-from/--old-b64 searched for):\n${diff}`,
      )
    }
    throw new CliError(`old string not found in ${file}`)
  }
  if (occurrences > 1 && !opts.all) {
    throw new CliError(`old string appears ${occurrences} times in ${file} — pass --all to replace every occurrence, or provide a more specific match`)
  }

  const parts: Buffer[] = []
  let prevEnd = 0
  for (const pos of matches) {
    parts.push(targetBuf.subarray(prevEnd, pos))
    parts.push(normalizedNewBytes)
    prevEnd = pos + normalizedOldBytes.length
  }
  parts.push(targetBuf.subarray(prevEnd))
  const replacedBuf = Buffer.concat(parts)

  writeReplacedBuffer(file, replacedBuf, preWriteStat)
  out(`replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${file}`)
}

export function cmdInsertSection(file: string, opts: { after: string; contentFrom?: string; contentB64?: string }): void {
  validateWritablePath(file, 'target file')

  const usingFrom = opts.contentFrom !== undefined
  const usingB64 = opts.contentB64 !== undefined
  if (usingFrom && usingB64) {
    throw new CliError('cannot mix --content-from with --content-b64')
  }
  if (!usingFrom && !usingB64) {
    throw new CliError('must provide either --content-from or --content-b64')
  }
  const contentBytes = usingFrom
    ? readFileBoundedRaw(opts.contentFrom!, '--content-from')
    : decodeBase64Buffer(opts.contentB64!, '--content-b64')
  if (contentBytes.length === 0) {
    throw new CliError('content to insert cannot be empty')
  }

  let preWriteStat: fs.Stats | undefined
  try {
    preWriteStat = fs.statSync(file)
  } catch {
    // If the file vanished
  }

  const result = readSection(file, opts.after)
  if (result === null) {
    const allHeadings = listSections(file)
    const messages = [`Section '${opts.after}' not found in '${file}'`]
    const available = filterSimilarHeadings(allHeadings, opts.after)
    if (available.length > 0) messages.push(didYouMean(available))
    else if (allHeadings.length > 0) messages.push(`Try: token-goat outline ${file}`)
    throw new CliError(messages.join('\n'))
  }

  if (result.occurrences !== undefined) {
    const lines = [
      `Ambiguous heading '${opts.after}' in '${file}': ${countNoun(result.occurrences.length, 'heading')} match. ` +
        `Retry with one of the qualified forms below to pick one:`,
    ]
    for (const [i, line] of result.occurrences.slice(0, AMBIGUOUS_HEADING_LIMIT).entries()) {
      lines.push(`  - line ${line}  ->  --after "${opts.after}#${i + 1}"`)
    }
    if (result.occurrences.length > AMBIGUOUS_HEADING_LIMIT) {
      lines.push(`  (${result.occurrences.length - AMBIGUOUS_HEADING_LIMIT} more not shown)`)
    }
    throw new CliError(lines.join('\n'))
  }

  let rawBytes: Buffer
  try {
    rawBytes = fs.readFileSync(file)
  } catch (e) {
    mapFsError(e, undefined, file)
  }
  const sourceEncoding = detectSourceEncoding(rawBytes)
  const rawText = decodeSource(rawBytes)

  const eol = detectDominantEol(Buffer.from(rawText, 'utf8'))
  const lfLines = rawText.replace(/\r\n/g, '\n').split('\n')
  const insertAt = result.lineEnd

  const insertedLines = contentBytes.toString('utf8').replace(/\r\n/g, '\n').split('\n')
  if (insertedLines.length > 0 && insertedLines[insertedLines.length - 1] === '') insertedLines.pop()

  const mergedLfText = [...lfLines.slice(0, insertAt), ...insertedLines, ...lfLines.slice(insertAt)].join('\n')
  const mergedText = eol === '\n' ? mergedLfText : mergedLfText.replace(/\n/g, '\r\n')

  if (preWriteStat !== undefined) {
    let preRenameStat: fs.Stats | undefined
    try {
      preRenameStat = fs.statSync(file)
    } catch {
      // Vanished
    }
    if (preRenameStat !== undefined && (preRenameStat.mtimeMs !== preWriteStat.mtimeMs || preRenameStat.size !== preWriteStat.size)) {
      throw new CliError(`${file} changed on disk while insert-section was running -- the file was modified concurrently, so the insert was NOT applied. Retry.`)
    }
  }

  try {
    atomicWriteBuffer(file, encodeSource(mergedText, sourceEncoding))
  } catch (e) {
    mapFsError(e, undefined, file)
  }
  enqueueDirtyPathSafe(file)
  const redirectNote = result.redirectedFrom !== undefined ? ` (redirected from: '${result.redirectedFrom}')` : ''
  out(`inserted after '${result.heading}'${redirectNote} in ${file}`)
}

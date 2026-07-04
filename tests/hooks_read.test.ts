import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preReadHandler, postReadHandler } from '../src/hooks_read.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileRead, wasFileReadThisSession, getSessionId } from '../src/session.js'
import { storeCompact, setSkillOutputsDirForTesting, contentHash } from '../src/skill_cache.js'
import { load as snapshotLoad } from '../src/snapshots.js'
import { FILE_TYPE_THRESHOLDS } from '../src/hints/file_type_handler.js'
import { makeHookEvent } from './helpers/hook-event.js'

const tmpFiles: string[] = []

function makeTmpFile(content = 'data'): string {
  const p = path.join(
    os.tmpdir(),
    `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
  )
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function _makeTmpMdFile(content = 'data'): string {
  const p = path.join(
    os.tmpdir(),
    `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
  )
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function readEvent(filePath: string | undefined): HookEvent {
  return makeHookEvent({
    toolName: 'Read',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test',
  })
}

// A Read call with offset/limit — the real Read tool schema's line-window params.
function readEventWithRange(filePath: string, offset?: number, limit?: number): HookEvent {
  const toolInput: Record<string, unknown> = { file_path: filePath }
  if (offset !== undefined) toolInput['offset'] = offset
  if (limit !== undefined) toolInput['limit'] = limit
  return makeHookEvent({
    toolName: 'Read',
    toolInput,
    sessionId: 'test',
  })
}

// A file made of many short lines totaling roughly `totalBytes` — realistic multi-line
// content (as opposed to a single padded-out line), so line-based offset/limit slicing
// actually has lines to work with.
function makeTmpMultilineFile(totalBytes: number): string {
  const lineTemplate = (i: number) => `line ${i.toString().padStart(6, '0')}: some sample content here\n`
  const perLine = lineTemplate(0).length
  const lineCount = Math.ceil(totalBytes / perLine)
  let content = ''
  for (let i = 0; i < lineCount; i++) content += lineTemplate(i)
  return makeTmpFile(content)
}

// Same shape as makeTmpMultilineFile but with a configurable extension, so offset/limit
// narrowing can be exercised through the HTML/CSV per-type branches (not just .txt).
function makeTmpMultilineFileWithExt(totalBytes: number, ext: string): string {
  const lineTemplate = (i: number) => `line ${i.toString().padStart(6, '0')}: some sample content here\n`
  const perLine = lineTemplate(0).length
  const lineCount = Math.ceil(totalBytes / perLine)
  let content = ''
  for (let i = 0; i < lineCount; i++) content += lineTemplate(i)
  const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function grepEvent(filePath: string | undefined): HookEvent {
  return makeHookEvent({
    toolName: 'Grep',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test',
  })
}

// The real Grep tool schema uses `path` (not `file_path`) for the search target.
function grepPathEvent(searchPath: string | undefined): HookEvent {
  return makeHookEvent({
    toolName: 'Grep',
    toolInput: searchPath === undefined ? {} : { path: searchPath },
    sessionId: 'test',
  })
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
  while (tmpFiles.length > 0) {
    const p = tmpFiles.pop()
    if (p === undefined) continue
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort cleanup
    }
  }
})

describe('preReadHandler', () => {
  it('returns pass when no file_path in input', () => {
    const result = preReadHandler(readEvent(undefined))
    expect(result.hookType).toBe('pass')
  })

  it('returns a re-read context hint when the file was already read (small file)', () => {
    const p = makeTmpFile()
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already read this session')
      expect(result.context).toContain('token-goat read/section/symbol')
    }
  })

  it('denies re-read of a large file (>50KB) that was already read this session', () => {
    const p = makeTmpFile('x'.repeat(60 * 1024))
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat read/section/symbol')
      expect(result.message).toContain('To edit it anyway')
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('returns a large-file context hint for files between 100KB and 500KB', () => {
    const p = makeTmpFile('x'.repeat(150 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('is large')
      expect(result.context).toContain('token-goat skeleton')
    }
  })

  it('denies first read of very large files (>500KB)', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
      expect(result.message).toContain('token-goat skeleton')
      expect(result.message).toContain('To edit it anyway')
      expect(result.message).toContain('token-goat replace')
    }
  })

  // Regression coverage for the false "retry with offset/limit" advice bug: the deny message
  // told callers to retry with offset/limit, but the hook never read those params at all, so
  // the retry always hit the byte-identical deny. These tests drive the fix end-to-end.
  it('allows a large file read when offset/limit narrows it to a small slice', () => {
    const p = makeTmpMultilineFile(600 * 1024)

    // Whole-file request still denies (sanity check the fixture is genuinely large).
    const wholeFile = preReadHandler(readEvent(p))
    expect(wholeFile.hookType).toBe('deny')

    // A real, bounded offset/limit request covering only a handful of lines is a tiny read —
    // it must be let through instead of gating on the whole file's size.
    const result = preReadHandler(readEventWithRange(p, 1, 50))
    expect(result.hookType).not.toBe('deny')
  })

  it('still denies a large file read with no offset/limit (a whole-file request)', () => {
    const p = makeTmpMultilineFile(600 * 1024)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
    }
  })

  it('still denies a large file read when offset/limit is given but the requested window is itself still large', () => {
    const p = makeTmpMultilineFile(600 * 1024)

    // limit covers effectively the whole file — not a genuinely narrowed request.
    const result = preReadHandler(readEventWithRange(p, 1, 100_000))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
      // True advice now that offset/limit is honored: tells the caller to narrow it further,
      // not to blindly retry with offset/limit again (which is what caused the original bug).
      expect(result.message).toContain('narrow the range further')
    }
  })

  // Regression guard: estimateRequestedSlice already clamps a sub-1 offset up to 1, but used to
  // pass a negative limit straight through unguarded. scanRequestedSlice computes
  // `windowEnd = offset + limit`; a negative limit makes windowEnd < offset, so the byte counter
  // never advances (the [offset, windowEnd) window is empty) and the very first line break trips
  // the "window closed" branch, returning a fabricated {bytes: 0, trustworthy: true} almost
  // immediately -- telling the pre-read size gate the requested window is trivially small even
  // though a Read call with a negative limit has no well-defined real-world size. That silently
  // bypassed the large-file deny for a genuinely huge file. Fixed by treating a non-positive
  // limit the same as a missing one: fall back to `kind: 'unbounded'` and gate on the whole file.
  it('does not treat a negative --limit as a trustworthy small slice on a large file', () => {
    const p = makeTmpMultilineFile(600 * 1024)

    const result = preReadHandler(readEventWithRange(p, 1, -1))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
    }
  })

  // Regression coverage for the undercounted-trustworthy scan-cap bug: scanRequestedSlice's
  // cap-hit branch used to mark its partial in-window byte count "trustworthy" any time the
  // window had merely started (lineNumber >= offset), even though the window hadn't closed and
  // the count was only "bytes seen so far", not the true window size. That handed the large-file
  // gate an undercounted figure and let a genuinely huge read pass as safe.
  it('does not let a huge read pass as safe via an undercounted trustworthy slice estimate when the scan cap is hit mid-window (fail-on-buggy: the cap-hit branch previously trusted a partial in-window byte count whenever the window had started, instead of falling back to gating on the whole file)', () => {
    // 2.3MB file: comfortably past the 2MB scan cap, so the scan gives up before EOF. With
    // offset=55100 sitting just below the ~55189th line where the cap lands, and limit=500000
    // keeping the window open well past the cap, the scan has only counted a few KB in-window
    // by the time it gives up — the old bug trusted that tiny partial count and let this
    // through, even though the true requested window is enormous relative to the file.
    const p = makeTmpMultilineFile(2_300_000)

    const result = preReadHandler(readEventWithRange(p, 55100, 500000))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
    }
  })

  it('denies a large mostly-single-line (base64-like) file without suggesting offset/limit, since line-windowing cannot shrink it', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))

    // Retrying with offset/limit — exactly what the old message suggested — must not be
    // treated as a valid narrowing for this shape, since there's ~1 line to window over.
    const result = preReadHandler(readEventWithRange(p, 1, 50))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
      expect(result.message).toContain('mostly one long line')
      // Must not repeat the old, false "use offset/limit" suggestion for this content shape.
      expect(result.message).not.toContain('Use Read with offset/limit to sample specific sections')
      expect(result.message).not.toContain('narrow the range further')
    }
  })

  it('allows a mid-size (20-100KB) .txt read when offset/limit narrows it to a small slice — exercises the universal file-type-handler branch (handleTxt), not just the top-level large-file gate', () => {
    // 50KB: above FILE_TYPE_THRESHOLDS.txt (20KB) but below LARGE_FILE_BYTES (100KB), so this
    // is gated by the per-type handler branch, not the earlier whole-file size branch.
    const p = makeTmpMultilineFile(50 * 1024)

    const whole = preReadHandler(readEvent(p))
    expect(whole.hookType).toBe('deny')

    const sliced = preReadHandler(readEventWithRange(p, 1, 50))
    expect(sliced.hookType).not.toBe('deny')
  })

  it('allows a mid-size (50-100KB) .html read when offset/limit narrows it to a small slice — exercises the universal file-type-handler branch (handleHtml), not just the top-level large-file gate', () => {
    // 60KB: above FILE_TYPE_THRESHOLDS.html (50KB) but below LARGE_FILE_BYTES (100KB), so this
    // is gated by the per-type handler branch, not the earlier whole-file size branch.
    const p = makeTmpMultilineFileWithExt(60 * 1024, 'html')

    const whole = preReadHandler(readEvent(p))
    expect(whole.hookType).toBe('deny')

    const sliced = preReadHandler(readEventWithRange(p, 1, 50))
    expect(sliced.hookType).not.toBe('deny')
  })

  it('allows a mid-size (10-100KB) .csv read when offset/limit narrows it to a small slice — exercises the universal file-type-handler branch (handleCsv), not just the top-level large-file gate', () => {
    // 20KB: above FILE_TYPE_THRESHOLDS.csv (10KB) but below LARGE_FILE_BYTES (100KB), so this
    // is gated by the per-type handler branch, not the earlier whole-file size branch.
    const p = makeTmpMultilineFileWithExt(20 * 1024, 'csv')

    const whole = preReadHandler(readEvent(p))
    expect(whole.hookType).toBe('deny')

    const sliced = preReadHandler(readEventWithRange(p, 1, 50))
    expect(sliced.hookType).not.toBe('deny')
  })

  it('does not poison re-read dedup when a first read is denied for being too large (>500KB) — a retry sees the same deny, not "already read"', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))
    const first = preReadHandler(readEvent(p))
    expect(first.hookType).toBe('deny')
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)

    const retry = preReadHandler(readEvent(p))
    expect(retry.hookType).toBe('deny')
    if (retry.hookType === 'deny') {
      expect(retry.message).toContain('is very large')
      expect(retry.message).not.toContain('already read this session')
    }
  })

  it('does not poison re-read dedup when a large CSV read is denied by the universal file-type handler', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.csv`)
    fs.writeFileSync(p, 'a,b\n' + 'x'.repeat(FILE_TYPE_THRESHOLDS.csv + 1000))
    tmpFiles.push(p)

    const first = preReadHandler(readEvent(p))
    expect(first.hookType).toBe('deny')
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)

    const retry = preReadHandler(readEvent(p))
    expect(retry.hookType).toBe('deny')
    if (retry.hookType === 'deny') {
      expect(retry.message).not.toContain('already read this session')
    }
  })

  it('treats a 101KB unrecognized-extension file via the unified 100KB threshold (soft hint, not a hard block)', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.xyz`)
    fs.writeFileSync(p, 'x'.repeat(FILE_TYPE_THRESHOLDS.generic + 1000))
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    // Above FILE_TYPE_THRESHOLDS.generic (100,000) and, with the thresholds unified,
    // also above the large-file soft-hint boundary — so this should get the soft
    // "is large" context nudge from the large-file branch (checked first), not the
    // generic file-type handler's hard block that fired below the old, higher
    // 102,400-byte LARGE_FILE_BYTES boundary.
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('is large')
    }
  })

  it('returns pass for a small, never-read file', () => {
    const p = makeTmpFile('small')
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('records the read on every call', () => {
    const p = makeTmpFile('small')
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)

    preReadHandler(readEvent(p))
    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)

    // A second call (now a re-read) still records, bumping the count.
    preReadHandler(readEvent(p))
    preReadHandler(readEvent(p))
    // Three handler calls => three recorded reads.
    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)
  })

  it('does not record when file_path is missing', () => {
    const result = preReadHandler(readEvent(undefined))
    expect(result.hookType).toBe('pass')
  })

  it('blocks reads under node_modules/ with a deny output', () => {
    const result = preReadHandler(readEvent('/project/node_modules/lodash/index.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
      expect(result.message).toContain('npm ls')
      expect(result.message).toContain('token-goat read')
    }
  })

  it('blocks reads under node_modules\\ (backslash) on all platforms', () => {
    const result = preReadHandler(readEvent('C:\\project\\node_modules\\react\\index.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
    }
  })

  it('blocks node_modules paths case-insensitively on Windows', () => {
    if (process.platform !== 'win32') {
      // Covered regardless of platform by the case-insensitive-fs test below (#isNodeModulesPath foldPath fix)
      expect(true).toBe(true)
      return
    }
    const result = preReadHandler(readEvent('C:\\PROJECT\\NODE_MODULES\\foo.js'))
    expect(result.hookType).toBe('deny')
  })

  it('blocks node_modules paths case-insensitively on a case-insensitive filesystem regardless of platform (#isNodeModulesPath foldPath fix)', () => {
    // Regression: isNodeModulesPath used to gate its case fold on isWindows() instead of
    // isCaseInsensitiveFs(), so a case-insensitive filesystem on a non-Windows platform (e.g.
    // macOS, which is case-insensitive by default) never got its path folded and a
    // differently-cased node_modules segment slipped through undetected. Force a non-Windows
    // platform AND a forced case-insensitive-fs override at the same time: under the old
    // isWindows()-gated code this combination fails (isWindows() is false, so no fold happens),
    // proving the test actually exercises the bug rather than passing trivially on a real
    // Windows dev machine where isWindows() is already true.
    const realPlatform = process.platform
    const prevCaseEnv = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    try {
      const result = preReadHandler(readEvent('/project/NODE_MODULES/foo.js'))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('node_modules is typically noise')
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
      if (prevCaseEnv === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
      else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = prevCaseEnv
    }
  })

  it('does not block paths with similar names outside node_modules', () => {
    const result = preReadHandler(readEvent('/project/my_node_modules_backup/file.js'))
    expect(result.hookType).toBe('pass')
  })

  it('also blocks Grep calls on node_modules paths', () => {
    const result = preReadHandler(grepEvent('/project/node_modules/package/file.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
    }
  })

  it('resolves the real Grep tool schema field ("path", not "file_path") so the Grep registration actually gates instead of being a no-op', () => {
    const result = preReadHandler(grepPathEvent('/project/node_modules/package/file.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
    }
  })

  it('passes through when a Grep call has neither "path" nor "file_path"', () => {
    const result = preReadHandler(grepPathEvent(undefined))
    expect(result.hookType).toBe('pass')
  })

  it('does not use the "path" fallback for the Read tool (Grep-scoped only)', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Read',
      toolInput: { path: '/project/node_modules/package/file.js' },
      sessionId: 'test',
      raw: {},
    }
    const result = preReadHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('does not hard-deny repeated Grep calls scoped to the same directory with different patterns — Grep cost/relevance depends on the pattern, not just the path, so it is exempt from the count-based re-read dedup', () => {
    const dir = '/project/src/components'
    const grepWithPattern = (pattern: string): HookEvent => ({
      eventName: 'pre_tool_use',
      toolName: 'Grep',
      toolInput: { path: dir, pattern },
      sessionId: 'test',
      raw: {},
    })

    const r1 = preReadHandler(grepWithPattern('useEffect'))
    expect(r1.hookType).not.toBe('deny')

    const r2 = preReadHandler(grepWithPattern('useState'))
    expect(r2.hookType).not.toBe('deny')

    // Before the fix, this 3rd Grep call on the same directory hard-denied via the
    // count-based re-read dedup (reads >= 2), even though the pattern differs each time.
    const r3 = preReadHandler(grepWithPattern('useMemo'))
    expect(r3.hookType).not.toBe('deny')

    const r4 = preReadHandler(grepWithPattern('useCallback'))
    expect(r4.hookType).not.toBe('deny')
  })

  it('does not hard-deny a Grep call against a file at/above the large-file deny threshold (500KB) — Grep\'s cost depends on its search pattern, not the file\'s total size, same rationale as the count-based re-read exemption above (fail-on-buggy: the whole-file large-size gate had no Grep exemption, so estimateRequestedSlice()\'s unbounded result for Grep gated it on the full file size and hard-denied it with a nonsensical "edit it anyway" message)', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'Grep',
      toolInput: { path: p, pattern: 'needle' },
      sessionId: 'test',
      raw: {},
    }

    const result = preReadHandler(event)
    expect(result.hookType).not.toBe('deny')
  })

  it('still hard-denies a whole-file Read against a file at/above the large-file deny threshold — the Grep size-gate exemption does not leak to Read', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
    }
  })

  it('still hard-denies the 3rd+ Read call on the same path — the Grep exemption does not leak to Read', () => {
    const dir = '/project/src/components'
    const r1 = preReadHandler(readEvent(dir))
    expect(r1.hookType).not.toBe('deny')

    const r2 = preReadHandler(readEvent(dir))
    expect(r2.hookType).not.toBe('deny')

    const r3 = preReadHandler(readEvent(dir))
    expect(r3.hookType).toBe('deny')
  })

  it('denies 2nd read of any .md file regardless of size', () => {
    const p = _makeTmpMdFile()
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat section')
      expect(result.message).not.toContain('skeleton')
      expect(result.message).not.toContain('read/section/symbol')
    }
  })

  it('gives a section-only large-file hint for .md files', () => {
    const p = _makeTmpMdFile('x'.repeat(150 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
      expect(result.context).not.toContain('skeleton')
    }
  })

  it('gives a context hint (not a deny) on the first read of a large markdown file with >=3 headings', () => {
    const mdContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

    const p = _makeTmpMdFile(mdContent + 'x'.repeat(10000))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Large markdown file')
      expect(result.context).toContain('# Title')
      expect(result.context).toContain('## Installation')
      expect(result.context).toContain('token-goat section')
    }
  })

  it('hard-denies a re-read of a large markdown file with >=3 headings', () => {
    const mdContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

    const p = _makeTmpMdFile(mdContent + 'x'.repeat(10000))
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Large markdown file')
      expect(result.message).toContain('# Title')
      expect(result.message).toContain('## Installation')
      expect(result.message).toContain('token-goat section')
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('hard-denies the FIRST read of a markdown file at/above the generic large-file deny threshold, even with >=3 headings (fail-on-buggy: the markdown branch previously let any first read through via contextOutput regardless of size, bypassing the 500KB deny every other file type gets)', () => {
    const mdContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

    // 500KB deny threshold (LARGE_FILE_DENY_BYTES in hooks_read.ts) — pad well past it.
    const p = _makeTmpMdFile(mdContent + 'x'.repeat(520 * 1024))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Large markdown file')
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('allows small markdown files to pass through even with headings', () => {
    const mdContent = `# Title
## Section
### Subsection`

    const p = _makeTmpMdFile(mdContent)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('allows large markdown files with <3 headings to pass through', () => {
    const mdContent = `# Title
Some content that makes the file large enough`

    const p = _makeTmpMdFile(mdContent + 'x'.repeat(10000))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('intercepts .mdx files with same rules as .md, denying only on re-read', () => {
    const mdContent = `# React Component
## Props
### Configuration
## Examples`

    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.mdx`,
    )
    fs.writeFileSync(p, mdContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    const first = preReadHandler(readEvent(p))
    expect(first.hookType).toBe('context')
    if (first.hookType === 'context') {
      expect(first.context).toContain('Large markdown file')
    }

    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Large markdown file')
    }
  })

  it('includes well-known sections in the re-read deny output for README.md', () => {
    const readmeContent = `# My Project
## Installation
## Usage
## API
## Configuration
## Getting Started`

    const p = path.join(
      os.tmpdir(),
      `README.md`,
    )
    fs.writeFileSync(p, readmeContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Quick access:')
      expect(result.message).toContain('Installation')
      expect(result.message).toContain('Usage')
      expect(result.message).toContain('API')
    }
  })

  it('gives context hint on 2nd read of a small file, deny on 3rd+', () => {
    const p = makeTmpFile('x'.repeat(5 * 1024))

    // First read: pass (never read before)
    const r1 = preReadHandler(readEvent(p))
    expect(r1.hookType).toBe('pass')

    // Second read: context (readCount is 1 after first pass recorded it)
    const r2 = preReadHandler(readEvent(p))
    expect(r2.hookType).toBe('context')

    // Third read: deny (readCount is now 2, so reads >= 2)
    const r3 = preReadHandler(readEvent(p))
    expect(r3.hookType).toBe('deny')
    if (r3.hookType === 'deny') {
      expect(r3.message).toContain('already read this session')
    }
  })

  it('counts a 3rd physical read as reads=2 even when it arrives under different path casing than the first-seen key (regression: the reread-count lookup used a direct getSessionFiles().get(normalized) instead of the case-fold-aware resolution recordFileRead/wasFileReadThisSession use, so a differently-cased 3rd read under-reported as reads=1 and returned "context" instead of "deny")', () => {
    const prevCaseEnv = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    try {
      // Vary only the basename's casing (keep the directory untouched) -- os.tmpdir() may
      // already be all-lowercase (e.g. Linux CI's "/tmp"), and resolveFilesKey's fold-scan is
      // only exercised when the queried string's own fold differs from itself, so uppercasing
      // just the basename reliably produces a "differently-cased" query on every platform.
      const p = makeTmpFile('x'.repeat(5 * 1024))
      const name = path.basename(p)
      const dir = path.dirname(p)
      const pUpper = path.join(dir, name.toUpperCase())
      const pTitle = path.join(dir, name.charAt(0).toUpperCase() + name.slice(1))

      // First read (first-seen casing): pass, records the _files key at this exact casing.
      const r1 = preReadHandler(readEvent(p))
      expect(r1.hookType).toBe('pass')

      // Second read under different casing: context (readCount is 1 after the first pass).
      const r2 = preReadHandler(readEvent(pUpper))
      expect(r2.hookType).toBe('context')

      // Third read under yet another casing: deny (readCount is now 2, so reads >= 2). Before
      // the fix this fell back to reads=1 and returned "context" because getSessionFiles().get()
      // missed the differently-cased key.
      const r3 = preReadHandler(readEvent(pTitle))
      expect(r3.hookType).toBe('deny')
      if (r3.hookType === 'deny') {
        expect(r3.message).toContain('already read this session (2 reads)')
      }
    } finally {
      if (prevCaseEnv === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
      else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = prevCaseEnv
    }
  })

  it('does not deny re-reads of an image via the generic re-read-dedup branch — the large-file-deny and universal-file-type branches already exempt isImagePath, but this third branch was missing the same exemption, so a same-size-or-larger image got a nonsensical "use token-goat read/section/symbol" deny on re-read', () => {
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.png`,
    )
    // 60KB: below LARGE_FILE_BYTES/FILE_TYPE_THRESHOLDS.generic (100KB) so neither of those
    // branches fires, but at/above REREAD_DENY_BYTES (50KB) so the size-based re-read deny in
    // the generic dedup branch would fire on an un-exempted 2nd read.
    fs.writeFileSync(p, Buffer.alloc(60 * 1024, 1))
    tmpFiles.push(p)

    const r1 = preReadHandler(readEvent(p))
    expect(r1.hookType).toBe('pass')

    const r2 = preReadHandler(readEvent(p))
    expect(r2.hookType).toBe('pass')

    // reads >= 2 unconditionally denies in the un-exempted branch, regardless of size.
    const r3 = preReadHandler(readEvent(p))
    expect(r3.hookType).toBe('pass')
  })

  // Count-based deny: 3rd+ read of source files (Item 1 — nestpilot mining)
  it('passes first read of a .ts source file', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(p, 'export function foo() {}')
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('gives context hint on 2nd read of a small .ts source file', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(p, 'export function foo() {}')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
  })

  it('hard-denies 3rd read of a small .ts source file with count-based message', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(p, 'export function foo() {}')
    tmpFiles.push(p)
    // Simulate 2 prior reads
    recordFileRead(normalizePath(p))
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Read this file')
      expect(result.message).toContain('times already')
      expect(result.message).toContain('token-goat skeleton')
      expect(result.message).toContain('token-goat outline')
      expect(result.message).toContain('To edit it anyway')
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('hard-denies 4th read of a .tsx source file', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.tsx`)
    fs.writeFileSync(p, 'export const App = () => <div/>')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    recordFileRead(normalizePath(p))
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat skeleton')
    }
  })

  it('does NOT apply count-based deny to .txt files (not a source extension)', () => {
    // .txt uses the existing generic logic, which emits context on 2nd read when small
    const p = makeTmpFile('plain text')
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    // Should be context (small file, 2nd read) — NOT the count-based deny
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).not.toContain('Read this file')
    }
  })

  it('denies re-read of .env file after first read', () => {
    const p = path.join(os.tmpdir(), `.env`)
    fs.writeFileSync(p, 'SECRET=abc\nOTHER=xyz\n')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('config-get')
    }
  })

  it('denies re-read of .env.local after first read', () => {
    const p = path.join(os.tmpdir(), `.env.local`)
    fs.writeFileSync(p, 'SECRET=abc\n')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('config-get')
    }
  })

  it('includes CHANGELOG version hint for large CHANGELOG.md files', () => {
    const changelogContent = `# Changelog

## [Unreleased]

## [2.1.0] - 2024-06-01

### Added
- New feature

## [2.0.0] - 2024-01-01`

    const p = path.join(
      os.tmpdir(),
      `CHANGELOG.md`,
    )
    fs.writeFileSync(p, changelogContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('[2.1.0]')
      expect(result.message).toContain('token-goat section')
    }
  })

  // Item 1: post-read truncation detection
  it('postReadHandler marks a file as truncated when response contains [Truncated:', () => {
    const p = makeTmpFile('some content')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: 'content here [Truncated: file too large, showing first 33K tokens]' },
    }
    postReadHandler(postEvent)

    // Next pre-read should be denied with skeleton hint
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('truncated on last read')
      expect(result.message).toContain('token-goat skeleton')
      expect(result.message).toContain('token-goat read')
    }
  })

  it('postReadHandler marks file truncated on PARTIAL view marker', () => {
    const p = makeTmpFile('content')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: 'first chunk Truncated: PARTIAL view of file' },
    }
    postReadHandler(postEvent)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('truncated on last read')
    }
  })

  it('postReadHandler does not mark file truncated when response has no marker', () => {
    const p = makeTmpFile('content')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: 'complete content with no truncation marker' },
    }
    postReadHandler(postEvent)
    // First pre-read should pass (not yet read)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  // Item 2: all .md/.mdx files denied on 2nd+ read regardless of size
  it('denies 2nd read of a large .md file', () => {
    const p = _makeTmpMdFile('# Title\n\ncontent\n'.padEnd(15 * 1024, 'x'))
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('denies 2nd read of a small .md file', () => {
    const p = _makeTmpMdFile('# Small\ncontent')
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('denies 2nd read of a .mdx file', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.mdx`)
    fs.writeFileSync(p, '# Component\n\ncontent\n'.padEnd(15 * 1024, 'x'))
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
    }
  })

  it('denies 2nd read of a .markdown file (M16: re-read-denial regex previously only matched .md/.mdx)', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.markdown`)
    fs.writeFileSync(p, '# Small\ncontent')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
    }
  })

  it('denies 2nd read of a .rst file with no snapshot (falls through to the markdown re-read denial)', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.rst`)
    fs.writeFileSync(p, 'Title\n=====\n\nSmall.\n')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Markdown file already read this session')
      expect(result.message).toContain('To edit it anyway')
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('postReadHandler stores a snapshot for .markdown files (m5: snapshot-storage regex previously excluded .markdown)', () => {
    const content = '# Doc\n\nContent.\n'
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.markdown`,
    )
    fs.writeFileSync(p, content)
    tmpFiles.push(p)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }
    postReadHandler(postEvent)

    const snap = snapshotLoad(getSessionId(), normalizePath(p))
    expect(snap).not.toBeNull()
    expect(snap?.toString('utf8')).toBe(content)
  })

  // Item 5: .improve-state-*.json re-read denial
  it('denies 2nd read of .improve-state-*.json', () => {
    const p = path.join(os.tmpdir(), '.improve-state-bugfixing.json')
    fs.writeFileSync(p, JSON.stringify({ phase: 'bugfixing' }))
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Orchestrator state already read')
    }
  })

  it('points the .improve-state-*.json re-read deny at a remedy that actually works — hooks_bash.ts exempts these files from every bash-output extraction site (isOrchestratorStateFile), so a bare `bash-output <id>` can never resolve to a cached entry', () => {
    const p = path.join(os.tmpdir(), '.improve-state-bugfixing.json')
    fs.writeFileSync(p, JSON.stringify({ phase: 'bugfixing' }))
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output --file "' + normalizePath(p) + '"')
      expect(result.message).not.toContain('bash-output <id>')
    }
  })

  it('passes first read of .improve-state-*.json', () => {
    const p = path.join(os.tmpdir(), '.improve-state-foo.json')
    fs.writeFileSync(p, JSON.stringify({ phase: 'foo' }))
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  // Item 8: MEMORY.md re-read denial
  it('denies 2nd read of memory/MEMORY.md', () => {
    const dir = path.join(os.tmpdir(), `tg-mem-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Memory\ncontent')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('MEMORY.md was read this session')
      expect(result.message).toContain('compact manifest')
    }
  })

  it('passes first read of memory/MEMORY.md', () => {
    const dir = path.join(os.tmpdir(), `tg-mem2-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Memory\ncontent')
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('denies 2nd read of any .md file under memory/ directory', () => {
    const dir = path.join(os.tmpdir(), `tg-mem3-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'project_findings.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Findings\ncontent')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('passes first read of memory/project_findings.md', () => {
    const dir = path.join(os.tmpdir(), `tg-mem4-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'project_findings.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Findings\ncontent')
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  // Doc-file auto-diff on re-read
  it('injects diff in deny when .md file content changed since last read', () => {
    const content1 = '# Title\n\nOriginal content here.\n'
    const content2 = '# Title\n\nOriginal content here.\n\n## New Section\n\nAdded content.\n'
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
    )
    fs.writeFileSync(p, content1)
    tmpFiles.push(p)

    // Simulate a successful Read: postReadHandler stores the snapshot
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content1 },
    }
    postReadHandler(postEvent)
    recordFileRead(normalizePath(p))

    // File changes between reads
    fs.writeFileSync(p, content2)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Content changed since last read')
      expect(result.message).toContain('```diff')
      expect(result.message).toContain('New Section')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('returns unchanged deny when .md file content is same as at last read', () => {
    const content = '# Title\n\nSome content.\n'
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
    )
    fs.writeFileSync(p, content)
    tmpFiles.push(p)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }
    postReadHandler(postEvent)
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('unchanged since last read')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('injects diff for .rst file that changed since last read', () => {
    const content1 = 'Title\n=====\n\nOriginal.\n'
    const content2 = 'Title\n=====\n\nOriginal.\n\nNew Section\n-----------\n\nAdded.\n'
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.rst`,
    )
    fs.writeFileSync(p, content1)
    tmpFiles.push(p)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content1 },
    }
    postReadHandler(postEvent)
    recordFileRead(normalizePath(p))

    fs.writeFileSync(p, content2)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Content changed since last read')
      expect(result.message).toContain('```diff')
    }
  })

  it('injects diff for .markdown file that changed since last read (isDocDiffable regex previously excluded .markdown, unlike its sibling regexes, so a changed .markdown fell through to the generic "already read" deny instead of serving the diff)', () => {
    const content1 = 'Title\n=====\n\nOriginal.\n'
    const content2 = 'Title\n=====\n\nOriginal.\n\nNew Section\n-----------\n\nAdded.\n'
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.markdown`,
    )
    fs.writeFileSync(p, content1)
    tmpFiles.push(p)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content1 },
    }
    postReadHandler(postEvent)
    recordFileRead(normalizePath(p))

    fs.writeFileSync(p, content2)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Content changed since last read')
      expect(result.message).toContain('```diff')
    }
  })

  it('postReadHandler stores snapshot for .md files (enables future diff)', () => {
    const content = '# Doc\n\nContent.\n'
    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
    )
    fs.writeFileSync(p, content)
    tmpFiles.push(p)

    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }
    // postReadHandler should complete without throwing
    expect(() => postReadHandler(postEvent)).not.toThrow()
  })

  // Source-file auto-diff on re-read (gated by serve_diff_on_reread) Helper: run a fn with the flag forced on/off, restoring the prior value.
  function withDiffFlag<T>(on: boolean, fn: () => T): T {
    const oldEnv = process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD
    if (on) process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD = '1'
    else delete process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD
    try {
      return fn()
    } finally {
      if (oldEnv === undefined) delete process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD
      else process.env.TOKEN_GOAT_SERVE_DIFF_ON_REREAD = oldEnv
    }
  }

  // Build a multi-line source file large enough that a 1-line change diffs well under the savings cap.
  function bigSource(varValue: number): string {
    const lines = Array.from({ length: 30 }, (_, i) => `  const x${i} = ${i === 5 ? varValue : i}`).join('\n')
    return `export function big() {\n${lines}\n  return 0\n}\n`
  }

  function tmpFileExt(content: string, ext: string): string {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`)
    fs.writeFileSync(p, content)
    tmpFiles.push(p)
    return p
  }

  function snapshotFirstRead(p: string, content: string): void {
    postReadHandler({
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    })
    recordFileRead(normalizePath(p))
  }

  it('flag ON: serves a diff (with symbol hint) on re-read of a changed .tsx', () => {
    withDiffFlag(true, () => {
      const content1 = bigSource(5)
      const p = tmpFileExt(content1, '.tsx')
      snapshotFirstRead(p, content1)
      fs.writeFileSync(p, bigSource(555)) // one line changed

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('Content changed since last read')
        expect(result.message).toContain('```diff')
        // Real unified-diff body, not just a substring of the new content.
        expect(result.message).toContain('-  const x5 = 5')
        expect(result.message).toContain('+  const x5 = 555')
        // .tsx is symbol-style: hint must point to `token-goat read ::Symbol`, not section
        expect(result.message).toContain('token-goat read')
      }
    })
  })

  it('flag ON: serves "unchanged" with a section hint on re-read of an unchanged .css', () => {
    withDiffFlag(true, () => {
      const content = '.hero {\n  color: red;\n}\n.footer {\n  color: blue;\n}\n'
      const p = tmpFileExt(content, '.css')
      snapshotFirstRead(p, content)

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('unchanged since last read')
        // .css is section-style
        expect(result.message).toContain('token-goat section')
      }
    })
  })

  it('flag OFF (default): re-read of a changed .tsx serves NO diff (preserves deny behavior)', () => {
    withDiffFlag(false, () => {
      const content1 = bigSource(5)
      const p = tmpFileExt(content1, '.tsx')
      snapshotFirstRead(p, content1) // flag off → no snapshot stored for .tsx
      fs.writeFileSync(p, bigSource(555))

      const result = preReadHandler(readEvent(p))
      // No diff is ever served when the flag is off — this is the key default-unchanged regression.
      expect(result.message ?? '').not.toContain('```diff')
    })
  })

  it('flag ON: savings guard — a minified single-line .json change falls through to deny (no diff)', () => {
    withDiffFlag(true, () => {
      const pairs1 = Array.from({ length: 40 }, (_, i) => `"k${i}":"v${i}"`).join(',')
      const pairs2 = Array.from({ length: 40 }, (_, i) => `"k${i}":"${i === 20 ? 'CHANGED' : 'v' + i}"`).join(',')
      const content1 = `{${pairs1}}`
      const content2 = `{${pairs2}}`
      const p = tmpFileExt(content1, '.json')
      snapshotFirstRead(p, content1)
      fs.writeFileSync(p, content2)

      const result = preReadHandler(readEvent(p))
      // Single-line file: the "diff" is ~2x the file, exceeding the 0.6 savings cap, so no diff is served.
      expect(result.message ?? '').not.toContain('```diff')
    })
  })

  it('flag ON: .yaml (in DIFFABLE_SOURCE_RE) gets the section-style hint on unchanged re-read', () => {
    withDiffFlag(true, () => {
      const content = 'name: app\nversion: 1\nsteps:\n  - build\n  - test\n'
      const p = tmpFileExt(content, '.yaml')
      snapshotFirstRead(p, content)

      const result = preReadHandler(readEvent(p))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('unchanged since last read')
        // .yaml is section-style, not symbol-style
        expect(result.message).toContain('token-goat section')
        expect(result.message).not.toContain('token-goat read')
      }
    })
  })

})

describe('preReadHandler — session artifact re-read dedup', () => {
  function makeTasksOutputFile(content = 'task output data'): string {
    const sessionDir = path.join(os.tmpdir(), `tg-session-${process.pid}-${Math.random().toString(36).slice(2)}`)
    const tasksDir = path.join(sessionDir, 'tasks')
    fs.mkdirSync(tasksDir, { recursive: true })
    const p = path.join(tasksDir, 'w9lh32xe0.output')
    fs.writeFileSync(p, content)
    tmpFiles.push(p)
    return p
  }

  it('emits a runnable --file recall hint on first read of tasks/*.output', () => {
    const p = makeTasksOutputFile()
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      // Must name a runnable command — bash-output --file "<path>" — not the old bare `--tail N` placeholder, which errors with "provide an <id> or --file".
      expect(result.context).toContain('token-goat bash-output --file "' + normalizePath(p) + '"')
      expect(result.context).toContain('--tail 50')
      expect(result.context).toContain('--grep')
      expect(result.context).not.toContain('--tail N')
    }
  })

  it('denies re-read of tasks/*.output when content unchanged since last read', () => {
    const content = 'task output data\nline two\n'
    const p = makeTasksOutputFile(content)
    const normalized = normalizePath(p)

    // Simulate: first read (context output fires, then postReadHandler captures snapshot)
    preReadHandler(readEvent(p))
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content },
    }
    postReadHandler(postEvent)
    recordFileRead(normalized)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('unchanged since last read')
      expect(result.message).toContain('token-goat bash-output --file "' + normalized + '"')
      expect(result.message).not.toContain('--tail N')
    }
  })

  it('injects diff in deny when tasks/*.output content changed since last read', () => {
    const content1 = 'task output line 1\ntask output line 2\n'
    const content2 = 'task output line 1\ntask output line 2\ntask output line 3 (added)\n'
    const p = makeTasksOutputFile(content1)
    const normalized = normalizePath(p)

    preReadHandler(readEvent(p))
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: content1 },
    }
    postReadHandler(postEvent)
    recordFileRead(normalized)

    fs.writeFileSync(p, content2)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Content changed since last read')
      expect(result.message).toContain('```diff')
      expect(result.message).toContain('token-goat bash-output --file "' + normalized + '"')
    }
  })
})

describe('preReadHandler - skill stale compact advisory', () => {
  const rnd = `${process.pid}-${Math.random().toString(36).slice(2)}`
  const skillsRoot = path.join(os.tmpdir(), `tg-skilladv-${rnd}`)
  const outputsDir = path.join(os.tmpdir(), `tg-skilladv-out-${rnd}`)
  const skillMd = path.join(skillsRoot, '.claude', 'skills', 'advskill', 'SKILL.md')

  beforeEach(() => {
    fs.mkdirSync(path.dirname(skillMd), { recursive: true })
    fs.mkdirSync(outputsDir, { recursive: true })
    setSkillOutputsDirForTesting(outputsDir)
  })

  afterEach(() => {
    setSkillOutputsDirForTesting(null)
    fs.rmSync(skillsRoot, { recursive: true, force: true })
    fs.rmSync(outputsDir, { recursive: true, force: true })
  })

  // Drives the real preReadHandler through the stale branch (no injected seam): a cached compact whose embedded source_sha != the body sha must yield the hint.
  it('emits a skill-compact hint when the cached compact is stale', async () => {
    fs.writeFileSync(skillMd, '# Adv Skill\n\nbody content here\n')
    await storeCompact('default', 'advskill', 'compact slice', 'deadbeefcafe')
    const result = preReadHandler(readEvent(skillMd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('skill-compact advskill')
    }
  })

  it('does not emit the hint when the compact sha matches the body', async () => {
    const body = '# Adv Skill\n\nfresh body\n'
    fs.writeFileSync(skillMd, body)
    await storeCompact('default', 'advskill', 'compact slice', contentHash(body).slice(0, 12))
    const result = preReadHandler(readEvent(skillMd))
    const text = result.hookType === 'context' ? result.context : ''
    expect(text).not.toContain('skill-compact advskill')
  })
})

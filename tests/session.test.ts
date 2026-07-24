import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import {
  exportSessionState,
  getBashOutputId,
  getFileLineRanges,
  getSessionFiles,
  getSessionId,
  getWebFetchCacheId,
  importSessionState,
  markFileTruncated,
  markHintShown,
  MAX_RANGES_PER_FILE,
  recordBashOutput,
  recordFileEdit,
  recordFileLineRange,
  recordFileRead,
  recordWebFetch,
  wasFileReadThisSession,
  wasHintShown,
} from '../src/session.js'

const tmpFiles: string[] = []

function makeTmpFile(content = 'data'): string {
  const p = path.join(os.tmpdir(), `tg-sess-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
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

describe('file read tracking', () => {
  it('wasFileReadThisSession is false initially, true after a read', () => {
    const p = makeTmpFile()
    expect(wasFileReadThisSession(p)).toBe(false)
    recordFileRead(p)
    expect(wasFileReadThisSession(p)).toBe(true)
  })

  it('recordFileRead increments readCount', () => {
    const p = makeTmpFile()
    recordFileRead(p)
    recordFileRead(p)
    recordFileRead(p)
    const files = [...getSessionFiles().values()]
    expect(files.length).toBe(1)
    expect(files[0]?.readCount).toBe(3)
  })

  it('captures file size at read time', () => {
    const p = makeTmpFile('1234567890')
    recordFileRead(p)
    const files = [...getSessionFiles().values()]
    expect(files.length).toBe(1)
    expect(files[0]?.sizeBytes).toBe(10)
  })
})

describe('case-insensitive filesystem path matching (#47)', () => {
  const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
  afterEach(() => {
    if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
    else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
  })

  // Regression: recordFileRead/wasFileReadThisSession/markFileTruncated/recordLargeFileHintPending
  // keyed their maps by normalizePath(filePath) alone. normalizePath only lowercases the drive
  // letter, so a second Read of the SAME physical file under different casing beyond the drive
  // letter (e.g. "Worker.ts" vs "worker.ts" -- Windows/macOS filesystems are case-insensitive)
  // missed the existing cache entry entirely and the "already read this session" dedup hint
  // silently failed to fire. Fold the map key with foldPath(), matching the established pattern
  // in worker.ts/index_prune.ts/sql_path.ts/walk_index.ts/read_commands.ts.
  it('recognizes a re-read of the same file under different casing as the same entry', () => {
    process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1'
    const p = makeTmpFile()
    const differentlyCased = p.toUpperCase()

    expect(wasFileReadThisSession(p)).toBe(false)
    recordFileRead(p)
    expect(wasFileReadThisSession(p)).toBe(true)

    // Same physical file, different literal casing -- must still be recognized as already read.
    expect(wasFileReadThisSession(differentlyCased)).toBe(true)

    const files = [...getSessionFiles().values()]
    expect(files.length).toBe(1)
  })

  it('control: case-sensitive FS treats differently-cased paths as distinct entries', () => {
    process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '0'
    const p = makeTmpFile()
    const differentlyCased = p.toUpperCase()

    recordFileRead(p)
    expect(wasFileReadThisSession(p)).toBe(true)
    expect(wasFileReadThisSession(differentlyCased)).toBe(false)
  })

  // The read-dedup map is round-tripped to disk between hook process invocations via
  // exportSessionState/importSessionState (see session_store.ts::loadSessionState /
  // saveSessionState). If importSessionState rebuilt the in-memory map keyed by the raw,
  // case-preserved FileEntry.path instead of a folded key, the fold fix above would only hold
  // for the lifetime of a single process and silently regress on the very next hook invocation.
  it('preserves the case-fold across an exportSessionState/importSessionState round-trip', () => {
    process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1'
    const p = makeTmpFile()
    recordFileRead(p)

    const snapshot = exportSessionState()
    importSessionState(snapshot)

    const differentlyCased = p.toUpperCase()
    expect(wasFileReadThisSession(differentlyCased)).toBe(true)
  })
})

describe('file edit tracking', () => {
  it('recordFileEdit sets wasEdited true', () => {
    const p = makeTmpFile()
    recordFileRead(p)
    recordFileEdit(p)
    const files = [...getSessionFiles().values()]
    expect(files[0]?.wasEdited).toBe(true)
  })

  it('edit-only file is tracked but not counted as read', () => {
    const p = makeTmpFile()
    recordFileEdit(p)
    expect(wasFileReadThisSession(p)).toBe(false)
    const files = [...getSessionFiles().values()]
    expect(files[0]?.wasEdited).toBe(true)
    expect(files[0]?.readCount).toBe(0)
  })
})

describe('recordFileEdit preserves other tracked flags (#M20)', () => {
  it('keeps wasTruncated set after an edit, matching the spread pattern recordFileRead/markFileTruncated use', () => {
    const p = makeTmpFile()
    recordFileRead(p)
    markFileTruncated(p)
    let files = [...getSessionFiles().values()]
    expect(files[0]?.wasTruncated).toBe(true)

    recordFileEdit(p)
    files = [...getSessionFiles().values()]
    expect(files[0]?.wasEdited).toBe(true)
    // recordFileEdit used to rebuild the entry field-by-field, silently dropping wasTruncated
    // instead of preserving it like the sibling read/truncate functions do.
    expect(files[0]?.wasTruncated).toBe(true)
  })
})

describe('recordFileEdit clears stale line ranges', () => {
  it('drops previously recorded sed line ranges when the file is edited without a prior full read', () => {
    const p = normalizePath(makeTmpFile())
    recordFileLineRange(p, 1, 50)
    expect(getFileLineRanges(p)).toEqual([[1, 50]])

    recordFileEdit(p)
    expect(getFileLineRanges(p)).toEqual([])
  })

  it('drops previously recorded sed line ranges when the file was read before being edited', () => {
    const p = normalizePath(makeTmpFile())
    recordFileRead(p)
    recordFileLineRange(p, 10, 20)
    expect(getFileLineRanges(p)).toEqual([[10, 20]])

    recordFileEdit(p)
    expect(getFileLineRanges(p)).toEqual([])
    const files = [...getSessionFiles().values()]
    expect(files[0]?.wasEdited).toBe(true)
  })

  it('does not clear line ranges recorded for a different, unedited file', () => {
    const edited = normalizePath(makeTmpFile())
    const other = normalizePath(makeTmpFile())
    recordFileLineRange(edited, 1, 10)
    recordFileLineRange(other, 1, 10)

    recordFileEdit(edited)

    expect(getFileLineRanges(edited)).toEqual([])
    expect(getFileLineRanges(other)).toEqual([[1, 10]])
  })

  it('drops stale line ranges when the record and edit calls use differently-formatted (but equivalent) path strings for the same file', () => {
    const p = normalizePath(makeTmpFile())
    const backslashForm = p.replace(/\//g, '\\')
    recordFileLineRange(backslashForm, 1, 50)
    expect(getFileLineRanges(p)).toEqual([[1, 50]])

    recordFileEdit(p)

    expect(getFileLineRanges(p)).toEqual([])
    expect(getFileLineRanges(backslashForm)).toEqual([])
  })
})

// Regression (mutation-testing gap): MAX_RANGES_PER_FILE's own doc comment says
// MAX_OUTSTANDING_AGENT_SPAWNS mirrors this cap's "cap-then-evict" shape, and that sibling cap
// has a dedicated bound test (hooks_agent_spawn.test.ts), but this cap itself had none. A
// mutation dropping the eviction splice entirely still passed the full suite -- a long session
// issuing many distinct sed/read-range calls on the same file would grow this list unboundedly.
describe('recordFileLineRange bounds ranges per file (mutation-testing gap)', () => {
  it('never exceeds MAX_RANGES_PER_FILE, keeping the most recently recorded ranges', () => {
    const p = normalizePath(makeTmpFile())
    for (let i = 0; i < MAX_RANGES_PER_FILE + 10; i++) {
      recordFileLineRange(p, i, i + 1)
    }
    const ranges = getFileLineRanges(p)
    expect(ranges.length).toBe(MAX_RANGES_PER_FILE)
    // Oldest ranges (0..9) evicted; most recent range retained.
    expect(ranges).not.toContainEqual([0, 1])
    expect(ranges).toContainEqual([MAX_RANGES_PER_FILE + 9, MAX_RANGES_PER_FILE + 10])
  })
})

describe('hint dedup', () => {
  it('markHintShown + wasHintShown round-trip', () => {
    expect(wasHintShown('reread:foo.ts')).toBe(false)
    markHintShown('reread:foo.ts')
    expect(wasHintShown('reread:foo.ts')).toBe(true)
    expect(wasHintShown('reread:other.ts')).toBe(false)
  })
})

describe('web fetch and bash output indexes', () => {
  it('web fetch tracking round-trips', () => {
    expect(getWebFetchCacheId('https://example.com')).toBeNull()
    recordWebFetch('https://example.com', '', 'cache-abc')
    expect(getWebFetchCacheId('https://example.com')).toBe('cache-abc')
  })

  it('retains separate cacheIds when the same url is fetched with different prompts', () => {
    recordWebFetch('https://example.com/doc', 'prompt A', 'cache-a')
    recordWebFetch('https://example.com/doc', 'prompt B', 'cache-b')
    expect(getWebFetchCacheId('https://example.com/doc', 'prompt A')).toBe('cache-a')
    expect(getWebFetchCacheId('https://example.com/doc', 'prompt B')).toBe('cache-b')
    expect(exportSessionState().webFetches.length).toBe(2)
  })

  it('bash output tracking round-trips', () => {
    expect(getBashOutputId('hash123')).toBeNull()
    recordBashOutput('hash123', 'out-456', 2048)
    expect(getBashOutputId('hash123')).toBe('out-456')
  })
})

describe('session id', () => {
  const ORIG_ENV = process.env['CLAUDE_CODE_SESSION_ID']

  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env['CLAUDE_CODE_SESSION_ID']
    else process.env['CLAUDE_CODE_SESSION_ID'] = ORIG_ENV
  })

  it('returns a consistent non-empty string across calls', () => {
    const a = getSessionId()
    const b = getSessionId()
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('uses CLAUDE_CODE_SESSION_ID from the environment when set', () => {
    process.env['CLAUDE_CODE_SESSION_ID'] = 'test-session-abc123'
    expect(getSessionId()).toBe('test-session-abc123')
  })

  it('falls back to a generated id when CLAUDE_CODE_SESSION_ID is unset', () => {
    delete process.env['CLAUDE_CODE_SESSION_ID']
    const id = getSessionId()
    expect(id.length).toBeGreaterThan(0)
    expect(id).not.toBe('test-session-abc123')
  })
})

describe('reset', () => {
  it('clearModuleCaches clears all session state', () => {
    const p = makeTmpFile()
    recordFileRead(p)
    markHintShown('h')
    recordWebFetch('u', '', 'c')
    recordBashOutput('cmd', 'oid', 1)

    clearModuleCaches()

    expect(wasFileReadThisSession(p)).toBe(false)
    expect(wasHintShown('h')).toBe(false)
    expect(getWebFetchCacheId('u')).toBeNull()
    expect(getBashOutputId('cmd')).toBeNull()
    expect(getSessionFiles().size).toBe(0)
  })
})

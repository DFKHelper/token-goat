import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearModuleCaches } from '../src/reset.js'
import {
  getBashOutputId,
  getSessionFiles,
  getSessionId,
  getWebFetchCacheId,
  markFileTruncated,
  markHintShown,
  recordBashOutput,
  recordFileEdit,
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
    recordWebFetch('https://example.com', 'cache-abc')
    expect(getWebFetchCacheId('https://example.com')).toBe('cache-abc')
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
    recordWebFetch('u', 'c')
    recordBashOutput('cmd', 'oid', 1)

    clearModuleCaches()

    expect(wasFileReadThisSession(p)).toBe(false)
    expect(wasHintShown('h')).toBe(false)
    expect(getWebFetchCacheId('u')).toBeNull()
    expect(getBashOutputId('cmd')).toBeNull()
    expect(getSessionFiles().size).toBe(0)
  })
})

// Ruling 78, on-demand path: a read command's self-heal never indexes a denied file. Provenance: HAND-DERIVED.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { runOutline } from '../src/read_outline.js'
import { runRead } from '../src/read_commands.js'
import { runSection } from '../src/read_section.js'
import { normalizePath } from '../src/paths.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { makeIndexer } from '../src/worker.js'

const DENIED = 'DeniedOndemandSym7q'
const OPEN = 'OpenOndemandSym7q'
let proj = ''
let prevCwd = ''
let prevProjectDir: string | undefined
let prevConfigDir: string | undefined

const code = (name: string, extra = ''): string =>
  `export function ${name}(): number {\n  return 1${extra}\n}\n`
const markdown = (name: string): string => `# ${name} title\n\nbody of ${name}\n\n## ${name} child\n\nmore\n`

function put(rel: string, body: string): string {
  const file = join(proj, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body)
  return file
}

function storedFor(file: string): string {
  const db = getDb(globalDbPath())
  const like = `%${normalizePath(file).split('/').pop() ?? ''}`
  const rows = [
    ...(db.prepare('SELECT file_path, name, body, docstring FROM symbols WHERE file_path LIKE ?')
      .all(like) as object[]),
    ...(db.prepare('SELECT file_path, text FROM chunks WHERE file_path LIKE ?').all(like) as object[]),
    ...(db.prepare('SELECT path FROM files WHERE path LIKE ?').all(like) as object[]),
  ]
  return JSON.stringify(rows)
}

function attempt(fn: () => { text: string; code: number }): string {
  try {
    const result = fn()
    return result.text
  } catch (err) {
    return (err as Error).message
  }
}

beforeEach(() => {
  prevCwd = process.cwd()
  prevProjectDir = process.env['CLAUDE_PROJECT_DIR']
  prevConfigDir = process.env['CLAUDE_CONFIG_DIR']
  proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-rd-ondemand-')))
  put('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(locked/**)'] } }))
  process.chdir(proj)
  process.env['CLAUDE_PROJECT_DIR'] = proj
  process.env['CLAUDE_CONFIG_DIR'] = join(proj, 'open', 'cfg')
  resetReadDenyCache()
})

afterEach(() => {
  process.chdir(prevCwd)
  if (prevProjectDir === undefined) delete process.env['CLAUDE_PROJECT_DIR']
  else process.env['CLAUDE_PROJECT_DIR'] = prevProjectDir
  if (prevConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = prevConfigDir
  resetReadDenyCache()
  rmSync(proj, { recursive: true, force: true })
})

describe('Ruling 78: read, outline and section self-heal never index a denied file', () => {
  it('read on a denied, not yet indexed file refuses and leaves no rows', () => {
    const file = put('locked/a.ts', code(DENIED))
    const text = attempt(() => runRead({ spec: `${file}::${DENIED}`, projectRoot: proj }))
    expect(text).not.toContain('return 1')
    expect(storedFor(file), 'denied file has no rows after read').toBe('[]')
  })

  it('outline on a denied, not yet indexed file refuses and leaves no rows', () => {
    const file = put('locked/b.ts', code(`${DENIED}B`))
    const text = attempt(() => runOutline({ file, projectRoot: proj } as never))
    expect(text).not.toContain('return 1')
    expect(storedFor(file), 'denied file has no rows after outline').toBe('[]')
  })

  it('section on a denied, not yet indexed file refuses and leaves no rows', () => {
    const file = put('locked/c.md', markdown(DENIED))
    const text = attempt(() => runSection({ spec: `${file}::${DENIED} title`, projectRoot: proj }))
    expect(text).not.toContain('body of')
    expect(storedFor(file), 'denied file has no rows after section').toBe('[]')
  })

  it('purges rows a denied file already holds when a read command touches it', () => {
    const file = put('locked/d.ts', code(`${DENIED}D`))
    put('.claude/settings.json', JSON.stringify({ permissions: { deny: [] } }))
    resetReadDenyCache()
    indexFileSync(normalizePath(file), globalDbPath())
    expect(storedFor(file)).toContain(`${DENIED}D`)
    writeFileSync(file, code(`${DENIED}D`, ' + 2'))
    put('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(locked/**)'] } }))
    resetReadDenyCache()
    attempt(() => runRead({ spec: `${file}::${DENIED}D`, projectRoot: proj }))
    expect(storedFor(file), 'rows stored before the denial are purged').toBe('[]')
  })

  it('indexes and prints an undenied file as before (control)', () => {
    const file = put('open/e.ts', code(OPEN))
    const text = attempt(() => runRead({ spec: `${file}::${OPEN}`, projectRoot: proj }))
    expect(text).toContain('return 1')
    expect(storedFor(file)).toContain(OPEN)
  })

  it('keeps an open file\'s rows when the deny check cannot run (no purge, nothing new indexed)', () => {
    const file = put('open/f.ts', code(`${OPEN}F`))
    indexFileSync(normalizePath(file), globalDbPath())
    const before = storedFor(file)
    expect(before).toContain(`${OPEN}F`)
    writeFileSync(file, code(`${OPEN}F`, ' + 1'))
    put('.claude/settings.json', '{ not json')
    resetReadDenyCache()
    attempt(() => runOutline({ file, projectRoot: proj } as never))
    expect(storedFor(file), 'rows survive an unknown verdict').toBe(before)
    const fresh = put('open/g.ts', code(`${OPEN}G`))
    attempt(() => runOutline({ file: fresh, projectRoot: proj } as never))
    expect(storedFor(fresh), 'an unchecked file is not indexed this round').toBe('[]')
    put('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(locked/**)'] } }))
    resetReadDenyCache()
    attempt(() => runOutline({ file: fresh, projectRoot: proj } as never))
    expect(storedFor(fresh), 'recovered once the settings load').toContain(`${OPEN}G`)
  })

  it('the worker indexer keeps an open file\'s rows and asks for a retry when the check cannot run', () => {
    const file = put('open/h.ts', code(`${OPEN}H`))
    const key = normalizePath(file)
    indexFileSync(key, globalDbPath())
    const before = storedFor(file)
    put('.claude/settings.json', '{ not json')
    resetReadDenyCache()
    const result = makeIndexer(globalDbPath())(key, fingerprintFile(key) as string)
    expect(storedFor(file), 'rows survive an unknown verdict').toBe(before)
    expect(result, 'a check that could not run is retried, not counted as indexed').not.toBe(true)
    expect(result).not.toBe(false)
  })
})

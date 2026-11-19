// Guard: every src file that reads file text or stored index text has its count pinned and classified.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { countSites, withoutComments, type SiteCounts } from './read_site_counter.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', '..', 'src')
const TABLE_JSON = path.join(HERE, 'read_deny_readers.json')

/** A file counts as checked when it calls a deny helper (a bare mention in a comment does not count). */
const DENY_CALL = /\b(?:dropDeniedRows|readDenial|assertReadAllowed)\(/

export interface ReaderEntry {
  /** Raw file-text read sites in the file, aliased imports and destructured aliases included. */
  reads: number
  /** Uses of an index accessor that returns stored text. */
  accessors: number
  /** One true reason, starting with a kind from KINDS. */
  reason: string
}
export type ReaderTable = Readonly<Record<string, ReaderEntry>>

/**
 * The kinds a reason may start with. `guarded at <file>:<symbol>:` names where the check lives; that file must
 * call a deny helper. `unreviewed` is not accepted once the table has been reviewed (see REVIEWED).
 */
export const KINDS = [
  'own state:',
  'fixed path:',
  'in-process:',
  'names only:',
  'count only:',
  'no source path:',
] as const
const GUARDED_AT = /^guarded at ([\w./]+):([\w.$]+): \S/
/** Set once every entry carries a reviewed reason; until then `unreviewed:` entries are tolerated. */
const REVIEWED = true

const TABLE: ReaderTable = JSON.parse(fs.readFileSync(TABLE_JSON, 'utf8')) as ReaderTable

export { withoutComments }

/** The counts of every file that reads, as the guard sees them. */
export function countAll(files: ReadonlyMap<string, string>): Map<string, SiteCounts> {
  const out = new Map<string, SiteCounts>()
  for (const [file, text] of files) {
    const c = countSites(text)
    if (c.reads > 0 || c.accessors > 0) out.set(file, c)
  }
  return out
}

function reasonProblem(reason: string, files: ReadonlyMap<string, string>): string | null {
  if (reason.startsWith('unreviewed:')) return REVIEWED ? 'is still unreviewed' : null
  if (KINDS.some((k) => reason.startsWith(k) && reason.length > k.length + 8)) return null
  const m = GUARDED_AT.exec(reason)
  if (m === null) return 'has a reason that starts with no known kind'
  const target = files.get(m[1]!)
  if (target === undefined) return `names a guard file that does not exist (${m[1]})`
  const code = withoutComments(target)
  if (!DENY_CALL.test(code)) return `names ${m[1]} as its guard but that file calls no deny helper`
  if (!new RegExp(`(?<![\\w$])${m[2]!.split('.').pop()!.replace(/\$/g, '\\$')}(?![\\w$])`).test(code)) {
    return `names ${m[1]}:${m[2]} as its guard but that symbol is not in the file`
  }
  return null
}

/** The source files that break the rule, as `file: reason`. */
export function violations(
  files: ReadonlyMap<string, string>,
  counts: ReadonlyMap<string, SiteCounts>,
  table: ReaderTable = TABLE,
): string[] {
  const found: string[] = []
  for (const [file, c] of counts) {
    const pin = table[file]
    if (pin === undefined) {
      found.push(`${file}: ${c.reads} read site(s) and ${c.accessors} accessor use(s) with no table entry`)
      continue
    }
    const move = (what: string, was: number, now: number): void => {
      if (now > was) found.push(`${file}: ${what} rose from ${was} to ${now}: classify the new one`)
      if (now < was) found.push(`${file}: ${what} fell from ${was} to ${now}: lower the pin`)
    }
    move('read sites', pin.reads, c.reads)
    move('accessor uses', pin.accessors, c.accessors)
  }
  for (const [file, pin] of Object.entries(table)) {
    if (!files.has(file)) found.push(`${file}: table entry but the file does not exist`)
    else if (!counts.has(file)) found.push(`${file}: table entry but the file no longer reads`)
    const problem = reasonProblem(pin.reason, files)
    if (problem !== null) found.push(`${file}: reason ${problem}`)
  }
  return found
}

function walk(dir: string, out: Map<string, string>, base = dir): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out, base)
    else if (e.name.endsWith('.ts')) {
      out.set(path.relative(base, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'))
    }
  }
}

describe('index text emitters honor the host Read deny rules', () => {
  const files = new Map<string, string>()
  walk(SRC, files)
  const counts = countAll(files)
  pinnedPopulation({
    what: 'TypeScript files under src/',
    items: [...files.keys()],
    floor: 400,
    mustInclude: ['read_deny.ts', 'read_symbol.ts', 'search/parallel_search.ts', 'worker.ts'],
  })

  /** The counts of the tree with one file replaced or added. */
  function plant(file: string, text: string): { files: Map<string, string>; counts: Map<string, SiteCounts> } {
    const planted = new Map(files)
    planted.set(file, text)
    const replaced = new Map(counts)
    replaced.delete(file)
    for (const [k, v] of countAll(new Map([[file, text]]))) replaced.set(k, v)
    return { files: planted, counts: replaced }
  }

  it('every file that reads file text or stored index text has its count pinned and classified', () => {
    expect(violations(files, counts)).toEqual([])
  })

  it('pins the worker, whose hash read happens before the indexer callback', () => {
    expect(TABLE['worker.ts']).toBeDefined()
  })

  it('fails by name on a second read planted in an already guarded file', () => {
    const guarded = 'text_trace.ts'
    expect(TABLE[guarded]).toBeDefined()
    const was = TABLE[guarded]!.reads
    const extra = "\nexport const planted = (p: string) => fs.readFileSync(p, 'utf8')\n"
    const p = plant(guarded, files.get(guarded)! + extra)
    expect(violations(p.files, p.counts)).toEqual([
      `${guarded}: read sites rose from ${was} to ${was + 1}: classify the new one`,
    ])
  })

  it('fails by name on a planted aliased import of a read', () => {
    const source = "import { readFileSync as rf } from 'node:fs'\nexport const f = (p: string) => rf(p)\n"
    const p = plant('planted_alias.ts', source)
    expect(violations(p.files, p.counts)).toEqual([
      'planted_alias.ts: 2 read site(s) and 0 accessor use(s) with no table entry',
    ])
  })

  it('fails by name on a planted openSync', () => {
    const source = "import * as fs from 'node:fs'\nexport const f = (p: string) => fs.openSync(p, 'r')\n"
    const p = plant('planted_open.ts', source)
    expect(violations(p.files, p.counts)).toEqual([
      'planted_open.ts: 1 read site(s) and 0 accessor use(s) with no table entry',
    ])
  })

  it('fails by name on planted destructured, promises, stream and helper reads', () => {
    const cases: Array<[string, string, number]> = [
      ['planted_destructure.ts', "const { readFileSync: rd } = fs\nexport const f = (p: string) => rd(p)\n", 3],
      ['planted_promises.ts', 'export const f = (p: string) => fs.promises.readFile(p)\n', 1],
      ['planted_handle.ts', "export const f = (p: string) => fs.promises.open(p, 'r')\n", 1],
      ['planted_stream.ts', 'export const f = (p: string) => createReadStream(p)\n', 1],
      ['planted_pdf.ts', 'export const f = (p: string) => readPdfFileWithinBounds(p)\n', 1],
    ]
    for (const [name, source, n] of cases) {
      const p = plant(name, source)
      expect(violations(p.files, p.counts), name).toEqual([
        `${name}: ${n} read site(s) and 0 accessor use(s) with no table entry`,
      ])
    }
  })

  it('fails by name on a planted accessor use, and ignores a read named only in a comment', () => {
    const emitter = "export const f = () => querySymbols({ name: 'x' })[0]!.body\n"
    const accessor = plant('planted_emitter.ts', emitter)
    expect(violations(accessor.files, accessor.counts)).toEqual([
      'planted_emitter.ts: 0 read site(s) and 1 accessor use(s) with no table entry',
    ])
    const text = '// readFileSync( is not called here\n/* openSync */\nexport const f = 1\n'
    const comment = plant('planted_comment.ts', text)
    expect(violations(comment.files, comment.counts)).toEqual([])
  })

  it('does not let a glob string swallow the code up to a later comment closer', () => {
    const source = "const glob = '**/*'\nexport const f = (p: string) => fs.readFileSync(p)\n/* closer */\n"
    expect(countSites(source).reads).toBe(1)
    const read = 'export const f = (p: string) => fs.readFileSync(p)\n'
    expect(countSites(`const a = '/*'\n${read}const b = '*/'\n`).reads).toBe(1)
  })

  it('does not count a checked wrapper', () => {
    expect(countSites('export const f = (p: string) => readFileText(p) ?? readFileBytes(p)\n').reads).toBe(0)
  })

  it('names a stale entry and a fallen count', () => {
    const stale = { ...TABLE, 'gone.ts': { reads: 1, accessors: 0, reason: 'own state: no such file at all' } }
    expect(violations(files, counts, stale)).toEqual(['gone.ts: table entry but the file does not exist'])
    const was = TABLE['text_trace.ts']!
    const bumped = { ...TABLE, 'text_trace.ts': { ...was, reads: was.reads + 1 } }
    expect(violations(files, counts, bumped)).toEqual([
      `text_trace.ts: read sites fell from ${was.reads + 1} to ${was.reads}: lower the pin`,
    ])
  })

  it('refuses a reason with no kind and a guard file with no deny call', () => {
    const was = TABLE['text_trace.ts']!
    const noKind = { ...TABLE, 'text_trace.ts': { ...was, reason: 'looks fine' } }
    expect(violations(files, counts, noKind)).toEqual([
      'text_trace.ts: reason has a reason that starts with no known kind',
    ])
    const badGuard = { ...TABLE, 'text_trace.ts': { ...was, reason: 'guarded at util.ts:x: not true' } }
    expect(violations(files, counts, badGuard)[0]).toContain('text_trace.ts: reason')
  })
})

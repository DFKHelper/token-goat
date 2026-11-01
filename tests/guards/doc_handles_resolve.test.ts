// Provenance: HAND-DERIVED from grep of the listed docs at 15d6e5cc1
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseFile } from '../../src/parser.js'
import { literalHeadingExists } from '../../src/read_section.js'
import { trackedFiles } from '../helpers/tracked-files.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Living docs whose `token-goat` commands an agent is told to run; `docs/plans/archive/` is mined from other repositories and stays out. */
const DOC_ROOT_FILES: ReadonlySet<string> = new Set(['CLAUDE.md', 'CLAUDE.arch.md', 'README.md', 'src/canonical_skill.md'])
const DOC_DIR = 'docs/'
const ARCHIVE_DIR = 'docs/plans/archive/'

const VERBS = ['read', 'section', 'brief', 'refs', 'impact'] as const
type Verb = (typeof VERBS)[number]

/** A quoted first argument after `token-goat <verb>`, with optional leading flags. */
const COMMAND = /token-goat\s+(?:-{1,2}[\w-]+\s+)*(read|section|brief|refs|impact)\s+"([^"\r\n]+)"/g

/** Handles the docs use as examples, not as real files. Hand-written on purpose; never generated from the scan. */
const PLACEHOLDER_HANDLES: ReadonlySet<string> = new Set([
  'file::symbol',
  'file::Symbol',
  'file::Heading',
  'doc.md::Heading',
  'src/auth.py::login',
])

/** Handles exempt at one doc site only, each with the reason read from that line. */
const SITE_EXEMPTIONS: ReadonlyArray<{ doc: string, handle: string }> = [
  // docs/PROMPT_SESSION_MINING.md:32 sits in a fenced Example Output card for a hypothetical session, not a live command.
  { doc: 'docs/PROMPT_SESSION_MINING.md', handle: 'src/auth.ts::verifyToken' },
]

/** Rows the extractor must keep in tracked docs, so a scanner that finds nothing cannot pass. */
const MUST_FIND: ReadonlyArray<{ doc: string, handle: string }> = [
  { doc: 'README.md', handle: 'README.md::Install' },
  { doc: 'docs/loop-invariants.md', handle: 'docs/loop-invariants.md::<Heading>' },
  { doc: 'docs/loop-ledger.md', handle: 'docs/loop-ledger.md::<Heading>' },
]

interface Handle { doc: string, line: number, verb: Verb, handle: string }
interface Failure { doc: string, line: number, handle: string, reason: string }

function isVerb(s: string | undefined): s is Verb {
  return VERBS.some((v) => v === s)
}

function isPlaceholder(h: Handle): boolean {
  if (PLACEHOLDER_HANDLES.has(h.handle) || /<[^>]+>/.test(h.handle)) return true
  return SITE_EXEMPTIONS.some((e) => e.doc === h.doc && e.handle === h.handle)
}

/** Every `token-goat <verb> "<file>::<name>"` in one document, with its 1-based line. */
function extractHandles(doc: string, text: string): Handle[] {
  const out: Handle[] = []
  for (const m of text.matchAll(COMMAND)) {
    const verb = m[1]
    const handle = m[2] ?? ''
    if (!isVerb(verb) || !handle.includes('::')) continue
    const line = text.slice(0, m.index ?? 0).split('\n').length
    out.push({ doc, line, verb, handle })
  }
  return out
}

/** The living documents, from the tracked-file listing, plus CLAUDE.md when it is on disk: it is gitignored, so a clean checkout (CI) has none and that leg is a no-op there. */
function livingDocs(tracked: readonly string[]): string[] {
  const docs = tracked.filter((p) => p.endsWith('.md') && (DOC_ROOT_FILES.has(p) || (p.startsWith(DOC_DIR) && !p.startsWith(ARCHIVE_DIR))))
  if (fs.existsSync(path.join(REPO, 'CLAUDE.md'))) docs.push('CLAUDE.md')
  return docs
}

/** Symbol names one file defines, parsed in-process: no worker and no index database. */
function symbolCache(): (abs: string) => Promise<readonly string[]> {
  const cache = new Map<string, Promise<readonly string[]>>()
  return (abs) => {
    const hit = cache.get(abs)
    if (hit !== undefined) return hit
    const names = parseFile(abs).then((r) => r.symbols.map((s) => s.name))
    cache.set(abs, names)
    return names
  }
}

/** The reason a handle does not resolve, or null when it does. */
async function failureOf(
  h: Handle,
  tracked: ReadonlySet<string>,
  symbolsIn: (abs: string) => Promise<readonly string[]>,
): Promise<string | null> {
  if (isPlaceholder(h)) return null
  const sep = h.handle.indexOf('::')
  const file = h.handle.slice(0, sep)
  const name = h.handle.slice(sep + 2)
  if (!tracked.has(file)) return `"${file}" is not a tracked file`
  const abs = path.join(REPO, file)
  if (h.verb === 'section') {
    const parts = literalHeadingExists(abs, name) ? [name] : name.split(',').map((p) => p.trim())
    const missing = parts.filter((p) => !literalHeadingExists(abs, p))
    return missing.length === 0 ? null : `no heading "${missing[0]}" in ${file}`
  }
  const names = await symbolsIn(abs)
  const parts = names.includes(name) ? [name] : name.split(',').map((p) => p.trim())
  const missing = parts.filter((p) => !names.includes(p))
  return missing.length === 0 ? null : `no symbol "${missing[0]}" in ${file}`
}

async function failuresOf(handles: readonly Handle[], tracked: ReadonlySet<string>): Promise<Failure[]> {
  const symbolsIn = symbolCache()
  const out: Failure[] = []
  for (const h of handles) {
    const reason = await failureOf(h, tracked, symbolsIn)
    if (reason !== null) out.push({ doc: h.doc, line: h.line, handle: h.handle, reason })
  }
  return out
}

describe('doc handles resolve', () => {
  it('every token-goat handle in a living doc names a tracked file and a real heading or symbol', async () => {
    const tracked = new Set(trackedFiles())
    const docs = livingDocs([...tracked])
    const handles: Handle[] = []
    for (const doc of docs) handles.push(...extractHandles(doc, fs.readFileSync(path.join(REPO, doc), 'utf8')))

    expect(docs.length, 'No living docs were found; the doc set or the tracked-file listing has changed.').toBeGreaterThan(5)
    expect(handles.length, 'Too few token-goat handles were found; the command regex has probably stopped matching the docs.').toBeGreaterThan(10)
    for (const must of MUST_FIND) {
      expect(tracked.has(must.doc),`${must.doc} is not a tracked file, so it cannot anchor a must-find row.`).toBe(true)
      expect(
        handles.some((h) => h.doc === must.doc && h.handle === must.handle),
        `The scanner dropped ${must.handle} from ${must.doc}.`,
      ).toBe(true)
    }

    const parsed = (await parseFile(path.join(REPO, 'src/parser.ts'))).symbols.map((s) => s.name)
    expect(parsed, 'The in-process parser returned no symbols for src/parser.ts, so symbol handles cannot be judged.').toContain('parseFile')

    const failures = await failuresOf(handles, tracked)
    const detail = failures.map((f) => `  ${f.doc}:${f.line}  "${f.handle}"  -> ${f.reason}`).join('\n')
    expect(
      failures,
      `${failures.length} token-goat handle(s) in the docs do not resolve:\n${detail}\n\n` +
      'Repoint the handle at the heading or symbol that now exists, or delete the command. ' +
      'An agent that runs a dead handle loses a turn.',
    ).toEqual([])
  })

  it('a scratch doc naming a missing heading or symbol fails on that handle by name', async () => {
    const scratch = [
      'token-goat section "README.md::Install"',
      'token-goat section "README.md::No Such Heading Anywhere"',
      'token-goat read "src/parser.ts::parseFile"',
      'token-goat read "src/parser.ts::parseFil"',
      'token-goat section "docs/missing-page.md::Install"',
      'token-goat read "file::symbol"',
    ].join('\n')
    const failures = await failuresOf(extractHandles('scratch.md', scratch), new Set(trackedFiles()))
    expect(failures.map((f) => f.handle)).toEqual([
      'README.md::No Such Heading Anywhere',
      'src/parser.ts::parseFil',
      'docs/missing-page.md::Install',
    ])
  })
})

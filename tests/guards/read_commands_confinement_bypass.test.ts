/**
 * Guard against the "a read path in read_commands.ts opens the file directly, bypassing the
 * confinement-aware helper" class -- the shape behind three real findings in one review pass:
 * `resolveSymbolSpec`'s `--force-refresh` branch and `healStaleIndex`'s self-heal both called
 * `indexFileSync` directly (a second, independent `fs.readFileSync` that never consulted
 * `activePins`), and `runGrep`'s `searchFile` read explicitly-requested files with a raw
 * `fs.readFileSync` for the same reason. All confinement-reachable content in this file must flow
 * through `readFileText` / `readFileBytes` (which check `activePins` via `readPinnedBytes`) or
 * through `indexFileSyncPinned` (which verifies the pin before handing already-read bytes to
 * `indexFileSync`) -- never a bare `fs.readFileSync` or a bare `indexFileSync(` call reached from
 * anywhere else in the file.
 *
 * This closes the CLASS, not just the three instances: it fails if any function OTHER than the
 * primitives below reintroduces a raw `fs.readFileSync(`/`indexFileSync(` call, so the next
 * command added to this file cannot quietly repeat the bypass.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

// Functions that are allowed to call `fs.readFileSync(` or `indexFileSync(` directly, because
// they ARE the confinement-aware primitives (or, for the pdf/image thin wrappers, read a file
// type this module's confinement gate does not currently cover at all -- see the exclusions note
// below). Every other function in this file must go through one of these instead.
const ALLOWED_RAW_READ_FUNCTIONS = new Set([
  'readPinnedBytes', // the actual fd-identity-checked open; this IS the primitive.
  'readFileText', // pin-aware text read; falls back to a raw read only when no pin is active.
  'readFileBytes', // pin-aware bytes read; same fallback contract as readFileText.
  'indexFileSyncPinned', // verifies the pin, then either reads itself (unpinned/ENOENT fallback) or forwards pre-verified bytes to indexFileSync.
  // pdf/image thin async wrappers: these read whole binary files for pdfjs-dist/sharp/OCR, a
  // format this module's MCP surface does not route through activePins today (no `read`/`grep`
  // tool resolves a spec to these). Pre-existing, out of scope for this guard's class -- listed
  // explicitly rather than silently excluded, so a future confinement pass covering these formats
  // has to touch this allowlist and notice it.
  'runImageMeta',
  'runImageText',
])

/** Scans `src/read_commands.ts` top-to-bottom, tracking which top-level function each line falls
 * inside via its `function name(` / `async function name(` declaration line, and returns every
 * `fs.readFileSync(` / bare `indexFileSync(` call site whose enclosing function is not in
 * `ALLOWED_RAW_READ_FUNCTIONS`. Top-level-only tracking is enough here: every offending call in
 * this file (pre- and post-fix) sits directly in a top-level function body, not nested inside a
 * further closure with its own name. */
function findRawReaders(): Map<string, string[]> {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'read_commands.ts'), 'utf8')
  const lines = src.split('\n')
  const fnDeclRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/
  // `indexFileSync(` also matches inside `indexFileSyncPinned(` as a substring, so the raw-call
  // pattern requires the character before the name not be part of a longer identifier -- a
  // negative lookbehind for a preceding `Sync` would be fragile against future renames, so this
  // instead matches the call form used at every real call site: `indexFileSync(` NOT immediately
  // preceded by `Pinned`.
  const offenderRe = /(?<!Pinned)\bindexFileSync\(|\bfs\.readFileSync\(/
  let currentFn = ''
  const readers = new Map<string, string[]>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const decl = fnDeclRe.exec(line)
    if (decl !== null) currentFn = decl[1]!
    if (!offenderRe.test(line)) continue
    const site = `src/read_commands.ts:${i + 1} (in ${currentFn || '<module scope>'}): ${line.trim()}`
    readers.set(currentFn, [...(readers.get(currentFn) ?? []), site])
  }
  return readers
}

function findRawReadOffenders(): string[] {
  return [...findRawReaders()].filter(([fn]) => !ALLOWED_RAW_READ_FUNCTIONS.has(fn)).flatMap(([, sites]) => sites)
}

describe('read_commands.ts confinement-reachable reads go through the pin-aware helpers', () => {
  it('no function outside the pin-aware primitives calls fs.readFileSync or indexFileSync directly', () => {
    const offenders = findRawReadOffenders()
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : 'A function in src/read_commands.ts reads a file (or reindexes one) directly instead of ' +
          'going through readFileText/readFileBytes or indexFileSyncPinned. Those helpers consult ' +
          'the MCP confinement gate\'s identity pin (activePins); a direct fs.readFileSync or ' +
          'indexFileSync call bypasses it entirely -- the exact shape behind three real ' +
          'confinement-bypass findings (force-refresh reindex, self-heal reindex, grep). If this is ' +
          'a genuinely new primitive, add it to ALLOWED_RAW_READ_FUNCTIONS with a reason; otherwise ' +
          'route the read through the existing helpers.',
    ).toEqual([])
  })

  it('every allowlisted name still holds a raw read, so a stale entry cannot widen the guard', () => {
    // An allowlist entry outlives the call it excused. The read one of these names covered moved
    // into pdf_extract.ts, and the entry would have stayed behind: harmless on its own, but it is
    // then a pre-approved name, and the next function to take it inherits an exemption nobody
    // decided to grant. So each name has to keep earning its place on every run.
    const readers = findRawReaders()
    const stale = [...ALLOWED_RAW_READ_FUNCTIONS].filter((fn) => !readers.has(fn))
    expect(
      stale,
      `ALLOWED_RAW_READ_FUNCTIONS names ${stale.join(', ')}, which no longer performs a raw read. ` +
        'Delete the entry rather than leaving a pre-approved name for a future function to inherit.',
    ).toEqual([])
  })

  it('the pin-aware helpers are actually present, so the guard cannot pass vacuously', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'read_commands.ts'), 'utf8')
    for (const fn of ['readFileText', 'readFileBytes', 'indexFileSyncPinned', 'readPinnedBytes']) {
      expect(src, `Expected src/read_commands.ts to still define ${fn}`).toContain(`function ${fn}(`)
    }
  })
})

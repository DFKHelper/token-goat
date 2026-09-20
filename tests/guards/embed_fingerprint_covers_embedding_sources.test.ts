/** A hand-curated list is the same failure mode PARSER_FINGERPRINT (and now EMBED_FINGERPRINT) was built to kill: the constant you have to remember to bump is exactly the thing that was already missing, and a list you have to remember to extend is that constant wearing a different hat. This test computes the transitive local-import closure of the embedding entry points -- src/embeddings.ts (the chunker and search/rerank driver), src/embedding_boundaries.ts (the module that turns already-written symbol/heading rows into chunk boundaries, split out of parser.ts precisely so this fingerprint can hash it without dragging in parse-only code), and src/parser.ts (indexFileEmbeddings, the real production driver that dispatches document extraction, dotenv redaction, and ipynb transformation before either of the other two ever runs) -- and demands every member land in exactly one of three places: embedFingerprintSources() (hashed directly, so an edit there moves EMBED_FINGERPRINT and forces a re-embed), transitively covered by PARSER_FINGERPRINT (embedUnchanged requires parseUnchanged at src/worker.ts:698 and src/cli.ts:342, so a parse-invalidating edit already forces a re-embed of the same file without needing its own place in this list), or NOT_EMBEDDING below (exempted, with a one-line reason this file's own author has to defend that does not merely restate "already covered" without saying by what mechanism). A closure member in none of the three is a silent gap: exactly the shape that let a chunker or document-extractor change go unnoticed for years, because files.embed_sha only ever compared content, never the code that turned that content into chunks. */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { embedFingerprintSources, extractionSources } from '../../scripts/parser-fingerprint.mjs'

const ROOT = process.cwd()

interface ClosureResult {
  closure: Set<string>
  // Every relative specifier that resolved to a path with no file on disk, keyed by the resolved repo-relative path it named, with the importer that named it. A silently-dropped unresolved edge shrinks the closure without failing anything, so a renamed or typoed import could quietly stop this guard from ever reaching the file it used to cover -- the size floor below could still pass on a smaller, wrong closure. Recording (never silently skipping) it is what makes that loud.
  unresolved: Map<string, string>
}

/** Every file under src/ transitively reachable from the given entry points by following relative `from './x.js'` / `from '../x.js'` specifiers or dynamic `import('...')` calls, with `.js` mapped back to the `.ts` source it was compiled from. Computed fresh every run, independent of embedFingerprintSources()'s own file list, or this guard would just be checking the list against itself. Every relative import in this repo's source resolves to a `.ts` file (verified: no relative import here names a `.json`/`.css`/`.wasm`/other non-TS asset), so treating every unresolved specifier as a real failure rather than a legitimately-non-TS import is safe today; if that ever changes, handle the new extension explicitly here rather than reopening the silent-skip this guard exists to close. */
function importClosureOf(entries: string[]): ClosureResult {
  const seen = new Set<string>()
  const unresolved = new Map<string, string>()
  const queue: Array<{ file: string; from: string }> = entries.map((e) => ({ file: e, from: '(entry point)' }))
  const importRe = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g
  while (queue.length > 0) {
    const { file, from } = queue.pop() as { file: string; from: string }
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    if (seen.has(rel)) continue
    if (!fs.existsSync(file)) {
      if (!unresolved.has(rel)) unresolved.set(rel, from)
      continue
    }
    seen.add(rel)
    const text = fs.readFileSync(file, 'utf8')
    let match: RegExpExecArray | null
    importRe.lastIndex = 0
    while ((match = importRe.exec(text)) !== null) {
      let resolved = path.resolve(path.dirname(file), match[1])
      resolved = resolved.endsWith('.js') ? `${resolved.slice(0, -3)}.ts` : `${resolved}.ts`
      queue.push({ file: resolved, from: rel })
    }
  }
  return { closure: seen, unresolved }
}

const ENTRY_POINTS = [
  path.join(ROOT, 'src', 'embeddings.ts'),
  path.join(ROOT, 'src', 'embedding_boundaries.ts'),
  path.join(ROOT, 'src', 'parser.ts'),
]

/** Every closure member that is neither hashed directly by embedFingerprintSources() nor transitively covered by PARSER_FINGERPRINT (see PARSER_HASHED below), each with a one-line reason a source edit there cannot change the chunk text or chunk boundaries a file's embedding produces. Every reason has to survive on its own: "not directly imported by embeddings.ts" is not a reason, since the whole point of a transitive closure is that indirect reach still counts, and "already covered by PARSER_FINGERPRINT" is not a reason either -- that mechanism is checked in code below (PARSER_HASHED), not asserted in prose, so a file needs an entry here only when NEITHER fingerprint's hashed set actually reaches it. */
const NOT_EMBEDDING: Record<string, string> = {
  'src/bridges/created_configs.ts': 'installer config-ledger bookkeeping (which config files token-goat created), reached only via util.ts, never by the chunker or a document extractor',
  'src/bridges/project_scope_guard.ts': 'write-scope confinement for installers, reached only via util.ts, never by the chunker or a document extractor',
  'src/bridges/registry.ts': 'detects which AI harness is running for hook wiring, reached only via config.ts; irrelevant to chunking',
  'src/bridges/types.ts': 'type-only declarations for harness names/bridge config, erased at compile time',
  'src/config.ts': 'runtime config values (e.g. chunk-size tunables); a digest cannot represent per-machine config values, since a user\'s own config already varies outside any digest -- these are runtime inputs this fingerprint does not and cannot model, and a maintainer changing a default is a deliberate, visible act, unlike the silent staleness this digest exists to catch',
  'src/config_defaults.ts': 'default runtime config values, same reasoning as src/config.ts',
  'src/config_project.ts': 'project-level config file resolution, same reasoning as src/config.ts',
  'src/config_types.ts': 'type-only config shape declarations, erased at compile time',
  'src/csv_query.ts': 'queryCsv (its only export xlsx_extract.ts uses) is called only by querySheet, a CLI-only xlsx-query surface; the embedding extraction function xlsx_extract.ts actually feeds into indexFileEmbeddings, allSheetsHeadText, never calls into this file -- hashing it would be over-broad, not under-broad, so it is exempted rather than hashed',
  'src/db.ts': 'database connection/schema infrastructure; excluded per this fingerprint\'s own design, same as src/paths.ts and src/version.ts',
  'src/embed_fingerprint.ts': 'the generated digest constant itself; hashing it into its own digest is self-referential',
  'src/embed_stamp.ts': 'resolves which EMBED_FINGERPRINT digest an already-embedded row should carry and which extraction kind a path belongs to -- a files.embed_sha bookkeeping concern, read only by ensureEmbeddingProvenance to scope a re-embed; it produces no chunk text and no boundary, and it lives outside embeddings.ts precisely so a stamp-lookup edit does not re-embed every file on the machine',
  'src/env.ts': 'generic env-var parsing helpers that feed runtime config values, same reasoning as src/config.ts',
  'src/fingerprint.ts': 'computes files.sha (content identity) via a generic SHA-256 utility, orthogonal to what gets chunked from that content',
  'src/injection_scan.ts': 'untrusted-content fencing for CLI/hook output display, reached via paths.ts, never applied to chunk text before embedding',
  'src/ocr_languages.ts': 'OCR language selection, reached only via config.ts\'s loadConfig; none of the document extractors on this path (pdf/docx/pptx/xlsx) perform OCR',
  'src/parser_stamp.ts': 'resolves which PARSER_FINGERPRINT digest an already-indexed row should carry -- a files.parser_sha concern that decides nothing about chunk text or chunk boundaries, and it lives outside parser_types.ts precisely so a stamp-lookup edit cannot move EMBED_FINGERPRINT',
  'src/parser_ts_types.ts': 'type-only tree-sitter node/parser interface declarations, erased at compile time',
  'src/path_containment.ts': 'path canonicalization/case-folding for containment security checks and path identity; decides path identity, not chunk text or boundary shape',
  'src/parser_fingerprint.ts': 'the generated PARSER_FINGERPRINT digest constant, imported by parser.ts to gate reparse -- a files.parser_sha concern, not files.embed_sha, and hashing a fingerprint constant into a different fingerprint would be circular',
  'src/paths.ts': 'cross-platform path normalization and display-time content fencing; affects path identity/display, not chunk text or boundaries -- excluded per explicit design, same as PARSER_FINGERPRINT',
  'src/process_util.ts': 'process/shell-quoting utilities for installers, reached only via util.ts, unrelated to chunking',
  'src/project.ts': 'project-root detection and hashing for scoping the index database, not chunk content',
  'src/reset.ts': 'test/dev module-cache clearing utility, never runs in a production embed',
  'src/sqlite_driver.ts': 'sqlite driver initialization, infrastructure like src/db.ts',
  'src/regex_guard.ts': 'ReDoS-safety guard for the CLI grep-pattern surfaces in pdf_extract.ts/pptx_extract.ts (pdfTextGrep/pptxTextGrep); the embedding extraction functions (extractPdfText, docxText, pptxAllSlidesText, allSheetsHeadText) never call it',
  'src/types.ts': 'type-only shared declarations (GitResult, HookEventName, etc.), erased at compile time',
  'src/util_config.ts': 'shared string-stripping helpers for uninstalling hooks from harness config files, reached only via util.ts, not chunking',
  'src/version.ts': 'the published package version string, excluded per this fingerprint\'s own design, same as PARSER_FINGERPRINT',
}

describe('the embed fingerprint covers every source that decides embedding chunk text and boundaries', () => {
  it('computes a non-trivial import closure, so this guard cannot pass vacuously', () => {
    const { closure } = importClosureOf(ENTRY_POINTS)
    expect(closure.size, 'the transitive import closure of the embedding entry points silently emptied or shrank far below its known size -- fix the closure walk before trusting anything else this test asserts').toBeGreaterThan(100)
  })

  it('resolves every relative import it follows, so a renamed or typoed edge cannot silently shrink the closure', () => {
    const { unresolved } = importClosureOf(ENTRY_POINTS)
    const detail = Array.from(unresolved.entries()).map(([target, from]) => `  ${target}  (imported by ${from})`).join('\n')
    expect(
      unresolved.size,
      `these relative imports could not be resolved to a file on disk while walking the embedding closure -- a broken import edge silently shrinks the closure instead of failing loudly, so fix the import or the walker:\n${detail}`,
    ).toBe(0)
  })

  it('classifies every closure member as hashed by embedFingerprintSources(), transitively covered by PARSER_FINGERPRINT, or explicitly exempted with a reason', () => {
    const { closure } = importClosureOf(ENTRY_POINTS)
    const hashed = new Set(embedFingerprintSources().map((f: string) => path.relative(ROOT, f).split(path.sep).join('/')))
    // A file PARSER_FINGERPRINT already hashes forces a reparse on any change, and embedUnchanged requires parseUnchanged (src/worker.ts:698, src/cli.ts:342) before it will even consider a file embed-fresh -- so a parse-invalidating edit to one of these already re-embeds the file too, transitively, with no separate entry in embedFingerprintSources() needed.
    const parserHashed = new Set(extractionSources().map((f: string) => path.relative(ROOT, f).split(path.sep).join('/')))

    const unclassified: string[] = []
    for (const file of closure) {
      if (hashed.has(file)) continue
      if (parserHashed.has(file)) continue
      if (Object.prototype.hasOwnProperty.call(NOT_EMBEDDING, file)) continue
      unclassified.push(file)
    }
    expect(
      unclassified,
      `these files are reachable from the embedding entry points but are neither hashed by embedFingerprintSources(), transitively covered by PARSER_FINGERPRINT, nor exempted in NOT_EMBEDDING: ${unclassified.join(', ')}. Add each to embedFingerprintSources() in scripts/parser-fingerprint.mjs if it decides chunk text or chunk boundaries, or add it to NOT_EMBEDDING in this test with a one-line reason why an edit there cannot change what gets embedded.`,
    ).toEqual([])
  })

  it('never exempts a file that has actually been hashed by either fingerprint, or the exemption list is lying about coverage', () => {
    const hashed = new Set(embedFingerprintSources().map((f: string) => path.relative(ROOT, f).split(path.sep).join('/')))
    const parserHashed = new Set(extractionSources().map((f: string) => path.relative(ROOT, f).split(path.sep).join('/')))
    const overlap = Object.keys(NOT_EMBEDDING).filter((f) => hashed.has(f) || parserHashed.has(f))
    expect(overlap, `these files are both hashed (by embedFingerprintSources() or extractionSources()) and exempted in NOT_EMBEDDING, which cannot both be true: ${overlap.join(', ')}`).toEqual([])
  })

  it('keeps every NOT_EMBEDDING entry pointed at a file that still exists', () => {
    const missing = Object.keys(NOT_EMBEDDING).filter((f) => !fs.existsSync(path.join(ROOT, f)))
    expect(
      missing,
      `these NOT_EMBEDDING entries no longer exist on disk and must be removed, or a future rename could silently widen the exemption to cover an unrelated new file at the same path: ${missing.join(', ')}`,
    ).toEqual([])
  })
})

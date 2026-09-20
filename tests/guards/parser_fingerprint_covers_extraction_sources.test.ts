/** A hand-curated list is the same failure mode PARSER_FINGERPRINT was built to kill: the constant you have to remember to bump is exactly the thing that was already missing, and a list you have to remember to extend is that constant wearing a different hat. This test computes the transitive local-import closure of src/parser.ts itself (not a restatement of it) and demands every member land in exactly one of two places -- extractionSources() (hashed, so an edit there moves PARSER_FINGERPRINT and forces a reparse) or NOT_EXTRACTION below (exempted, with a one-line reason this file's own author has to defend). A closure member in neither set is a silent gap: exactly the shape that let language_specs.ts and parser_types.ts decide extraction for years without ever touching the digest that was supposed to invalidate on an extraction-logic change. */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { extractionSources } from '../../scripts/parser-fingerprint.mjs'

const ROOT = process.cwd()

interface ClosureResult {
  closure: Set<string>
  // Every relative specifier that resolved to a path with no file on disk, keyed by the resolved repo-relative path it named, with the importer that named it. A silently-dropped unresolved edge shrinks the closure without failing anything, so a renamed or typoed import could quietly stop this guard from ever reaching the file it used to cover -- the size floor below could still pass on a smaller, wrong closure. Recording (never silently skipping) it is what makes that loud.
  unresolved: Map<string, string>
}

/** Every file under src/ transitively reachable from src/parser.ts by following relative `from './x.js'` / `from '../x.js'` specifiers, with `.js` mapped back to the `.ts` source it was compiled from. Computed fresh every run, independent of extractionSources()'s own file list, or this guard would just be checking the list against itself. Every relative import in this repo's source resolves to a `.ts` file (verified: no relative import here names a `.json`/`.css`/`.wasm`/other non-TS asset), so treating every unresolved specifier as a real failure rather than a legitimately-non-TS import is safe today; if that ever changes, handle the new extension explicitly here rather than reopening the silent-skip this guard exists to close. */
function importClosureOf(entry: string): ClosureResult {
  const seen = new Set<string>()
  const unresolved = new Map<string, string>()
  const queue: Array<{ file: string; from: string }> = [{ file: entry, from: '(entry point)' }]
  // Both edge kinds, because the regex language adapters are reached only by the dynamic import at src/parser.ts:514 -- a `from`-only walker would never traverse into src/languages/ and would classify a future extraction helper that lives behind that branch as unreachable rather than unhashed.
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

/** Every closure member that is not in extractionSources(), each with a one-line reason a source edit there cannot change what an unchanged file's next parse extracts. Every reason has to survive on its own: "not directly imported by parser.ts" is not a reason, since the whole point of a transitive closure is that indirect reach still counts. */
const NOT_EXTRACTION: Record<string, string> = {
  'src/bridges/created_configs.ts': 'installer config-ledger bookkeeping (which config files token-goat created), reached only via util.ts/install.ts/config.ts, never by an extractor',
  'src/bridges/project_scope_guard.ts': 'write-scope confinement for installers, reached only via util.ts/util_config.ts, never by an extractor',
  'src/bridges/registry.ts': 'detects which AI harness is running for hook wiring; irrelevant to parsing file content',
  'src/bridges/types.ts': 'type-only declarations for harness names/bridge config, erased at compile time',
  'src/config.ts': 'runtime config values; the values are already reflected in what gets indexed (e.g. large_file_symbol_only_kb), not compiled into extraction logic itself',
  'src/config_defaults.ts': 'default runtime config values, same reasoning as src/config.ts',
  'src/config_project.ts': 'project-level config file resolution, same reasoning as src/config.ts',
  'src/config_types.ts': 'type-only config shape declarations, erased at compile time',
  'src/csv_query.ts': 'CSV table querying used by xlsx_extract.ts and the read_structured_data CLI surface, part of the document/embedding pipeline gated by files.embed_sha, not files.parser_sha',
  'src/db.ts': 'database connection/schema infrastructure; excluded per this fingerprint\'s own design (see extractionSources() doc comment)',
  'src/doc_embed_extract.ts': 'dispatches pdf/docx/pptx/xlsx text extraction for indexFileEmbeddings only, gated by files.embed_sha',
  'src/document_refusal.ts': 'base error type for document-extraction timeouts/refusals in the embed_sha-gated pipeline',
  'src/docx_extract.ts': 'docx text extraction feeding indexFileEmbeddings only, gated by files.embed_sha',
  'src/dotenv_redact.ts': 'redactIfDotenv is applied inside indexFileEmbeddings (parser.ts line ~1145) before chunking for embeddings, never before indexFileSync\'s symbol/ref extraction',
  'src/embed_model.ts': 'embedding model loading, part of the embed_sha-gated pipeline',
  'src/embed_tokenizer.ts': 'embedding tokenizer, part of the embed_sha-gated pipeline',
  'src/embed_fingerprint.ts': 'the generated EMBED_FINGERPRINT digest constant, folded into embeddingProvenance() by src/embeddings.ts; a files.embed_sha concern, not files.parser_sha',
  'src/embedding_boundaries.ts': 'buildEmbeddingBoundaries derives embedding chunk boundaries (files.embed_sha) from already-written symbol/heading rows; reached from parser.ts only via its re-export, never by indexFileSync\'s symbol/ref extraction. Hashed by EMBED_FINGERPRINT instead, see tests/guards/embed_fingerprint_covers_embedding_sources.test.ts',
  'src/embed_stamp.ts': 'resolves which EMBED_FINGERPRINT digest a path\'s extraction kind carries, so a re-embed can be scoped to one document format; a files.embed_sha concern that reads no source and extracts nothing',
  'src/embeddings.ts': 'chunk/vector storage for semantic search, gated by files.embed_sha, not files.parser_sha',
  'src/env.ts': 'generic env-var parsing helpers that feed runtime config values, same reasoning as src/config.ts',
  'src/fingerprint.ts': 'computes files.sha (content identity) via a generic SHA-256 utility, orthogonal to what the parser extracts from that content',
  'src/hints/markdown_hints.ts': 'extractMarkdownHeadings is reached from parser.ts only via buildEmbeddingBoundaries, which derives embedding chunk boundaries (files.embed_sha), not symbol/ref/section extraction',
  'src/index_reader.ts': 'querySymbols is used inside buildEmbeddingBoundaries to read back already-written symbol rows for embedding chunking, and elsewhere only by CLI read commands; it never decides what indexFileSync writes',
  'src/injection_scan.ts': 'untrusted-content fencing for CLI/hook output display, reached via paths.ts, never applied to stored symbol/ref/section content',
  'src/lazy_module.ts': 'generic optional-dependency lazy-loader factory used by pdf/ooxml_extract.ts (embed_sha pipeline) and unrelated CLI surfaces; carries no extraction decisions itself',
  'src/ocr_languages.ts': 'OCR language selection for image/PDF text extraction, part of the embed_sha-gated document pipeline',
  'src/ooxml_extract.ts': 'shared zip/XML helpers for docx/pptx/xlsx extraction, part of the embed_sha-gated pipeline',
  'src/parser_fingerprint.ts': 'the generated digest constant itself; hashing it into its own digest is self-referential',
  'src/parser_stamp.ts': 'reads back which digest an already-indexed row should carry from the generated map in parser_fingerprint.ts; it resolves a stamp rather than deciding what a parse extracts, so hashing it would make every edit here invalidate every file for nothing',
  'src/parser_ts_types.ts': 'type-only tree-sitter node/parser interface declarations, erased at compile time',
  'src/path_containment.ts': 'path canonicalization/case-folding for containment security checks and path identity; does not choose an extractor or shape extracted content',
  'src/paths.ts': 'cross-platform path normalization (WSL/MSYS/UNC) and display-time content fencing; affects path identity, not what is extracted from a file\'s content',
  'src/pdf_extract.ts': 'PDF text extraction feeding indexFileEmbeddings only, gated by files.embed_sha',
  'src/pptx_extract.ts': 'PPTX text extraction feeding indexFileEmbeddings only, gated by files.embed_sha',
  'src/process_util.ts': 'process/shell-quoting utilities for installers, unrelated to parsing',
  'src/project.ts': 'project-root detection and hashing for scoping the index database, not content extraction',
  'src/regex_guard.ts': 'ReDoS-safety guard for user-supplied CLI regex flags (grep/affected/secret-redact); reached in this closure only via util.ts, never by a language extractor\'s own pattern',
  'src/reset.ts': 'test/dev module-cache clearing utility, never runs in a production parse',
  'src/sql_path.ts': 'builds a SQL WHERE clause for path-equality lookups; a query-shaping helper, not an extraction decision',
  'src/sqlite_driver.ts': 'sqlite driver initialization, infrastructure like src/db.ts',
  'src/types.ts': 'type-only shared declarations, erased at compile time',
  'src/util_config.ts': 'shared string-stripping helpers for uninstalling hooks from harness config files, not extraction',
  'src/version.ts': 'the published package version string, excluded per this fingerprint\'s own design (see extractionSources() doc comment) since it changes on every release',
  'src/xlsx_extract.ts': 'XLSX text extraction feeding indexFileEmbeddings only, gated by files.embed_sha',
  'src/xlsx_reader.ts': 'XLSX sheet-reading helper used only by xlsx_extract.ts, part of the embed_sha-gated pipeline',
  'src/xml_parser.ts': 'generic XML parsing used only by ooxml_extract.ts, part of the embed_sha-gated pipeline',
  'src/zip_bounds.ts': 'zip-bomb-safety bounds checking used only by the office-document (embed_sha) extraction pipeline and unrelated archive/read CLI surfaces',
}

describe('the parser fingerprint covers every source that decides extraction', () => {
  it('computes a non-trivial import closure, so this guard cannot pass vacuously', () => {
    const { closure } = importClosureOf(path.join(ROOT, 'src', 'parser.ts'))
    expect(closure.size, 'the transitive import closure of src/parser.ts silently emptied or shrank far below its known size -- fix the closure walk before trusting anything else this test asserts').toBeGreaterThan(100)
  })

  it('resolves every relative import it follows, so a renamed or typoed edge cannot silently shrink the closure', () => {
    const { unresolved } = importClosureOf(path.join(ROOT, 'src', 'parser.ts'))
    const detail = Array.from(unresolved.entries()).map(([target, from]) => `  ${target}  (imported by ${from})`).join('\n')
    expect(
      unresolved.size,
      `these relative imports could not be resolved to a file on disk while walking the extraction closure -- a broken import edge silently shrinks the closure instead of failing loudly, so fix the import or the walker:\n${detail}`,
    ).toBe(0)
  })

  it('classifies every closure member as either hashed by extractionSources() or explicitly exempted with a reason', () => {
    const { closure } = importClosureOf(path.join(ROOT, 'src', 'parser.ts'))
    const hashed = new Set(extractionSources().map((f: string) => path.relative(ROOT, f).split(path.sep).join('/')))

    const unclassified: string[] = []
    for (const file of closure) {
      if (hashed.has(file)) continue
      if (Object.prototype.hasOwnProperty.call(NOT_EXTRACTION, file)) continue
      unclassified.push(file)
    }
    expect(
      unclassified,
      `these files are reachable from src/parser.ts but are neither hashed by extractionSources() nor exempted in NOT_EXTRACTION: ${unclassified.join(', ')}. Add each to extractionSources() in scripts/parser-fingerprint.mjs if it decides what a parse extracts, or add it to NOT_EXTRACTION in this test with a one-line reason why an edit there cannot change extraction output.`,
    ).toEqual([])
  })

  it('never exempts a file that has actually been hashed, or the exemption list is lying about coverage', () => {
    const hashed = new Set(extractionSources().map((f: string) => path.relative(ROOT, f).split(path.sep).join('/')))
    const overlap = Object.keys(NOT_EXTRACTION).filter((f) => hashed.has(f))
    expect(overlap, `these files are both hashed and exempted, which cannot both be true: ${overlap.join(', ')}`).toEqual([])
  })

  it('keeps every NOT_EXTRACTION entry pointed at a file that still exists', () => {
    const missing = Object.keys(NOT_EXTRACTION).filter((f) => !fs.existsSync(path.join(ROOT, f)))
    expect(
      missing,
      `these NOT_EXTRACTION entries no longer exist on disk and must be removed, or a future rename could silently widen the exemption to cover an unrelated new file at the same path: ${missing.join(', ')}`,
    ).toEqual([])
  })
})

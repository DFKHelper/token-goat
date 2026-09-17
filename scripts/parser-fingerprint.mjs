#!/usr/bin/env node
// Generate (or verify) src/parser_fingerprint.ts and src/embed_fingerprint.ts, the digests of token-goat's two independent freshness keys: what a parse extracts (files.parser_sha) and what the embedding pipeline turns a file's bytes into (files.embed_sha, folded into embeddingProvenance()).
//
// files.sha answers "has this file's content changed since we parsed it". Nothing answered "has what we extract from that content changed", so a parser change left every already-indexed unchanged file pinned to its old symbol set forever: `token-goat index` reported them skipped and they kept stale rows until someone happened to edit each one. Measured on a real index, 37 of 237 source files disagreed with what the same binary produces from scratch, 180 surplus rows in all. The embedding half had the identical hole: files.embed_sha records which content was embedded, never which chunker or document extractor produced the chunk text, so a change to chunkFile, buildEmbeddingBoundaries, or a pdf/docx/pptx/xlsx extractor left every already-embedded file's vectors stale and unreachable by `token-goat index` forever. EMBED_FINGERPRINT closes that half by folding into embeddingProvenance(), whose existing mismatch path (ensureEmbeddingProvenance) already resets and re-embeds on any change.
//
// Hashing the extraction/embedding sources rather than a hand-bumped constant is the point: a constant you have to remember to bump is exactly the thing that was already missing. The cost is that any edit to these files changes the digest, so the next bulk index reparses or re-embeds everything. That is the correct trade: a reparse/re-embed costs time once, a silently wrong index costs correctness indefinitely.
//
// Usage:
//   node scripts/parser-fingerprint.mjs           regenerate both constants
//   node scripts/parser-fingerprint.mjs --check    exit 1 if either checked-in constant is stale
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PARSER_OUT = path.join(ROOT, 'src', 'parser_fingerprint.ts')
const EMBED_OUT = path.join(ROOT, 'src', 'embed_fingerprint.ts')

/** Every source that decides what a parse extracts: the driver, every language adapter, and the modules that pick which extractor runs and what it yields (language/extraction-method detection, tree-sitter node-kind mapping, structured-config extraction, ref extraction, doc comments, and source-encoding decoding, since decodeSource's output is the text every extractor parses). Two grab-bags are in for one export each and cost a reparse on every unrelated edit to them, which is the cheaper half of the trade: constants.ts for SYMBOL_BODY_CHAR_CAP, which bounds every stored symbol body (src/parser.ts's boundSymbolBody and the tree-sitter fan-out elision), and util.ts for countContentLines, which sets line_end for fourteen regex adapters, and escapeRegExp, which builds their patterns. Deliberately excludes: install/bridge/config/db/version/path-identity/env infrastructure that never shapes extracted content, type-only declaration files (erased at compile time), and the document/embedding pipeline (pdf/docx/pptx/xlsx extraction, OCR, chunking, dotenv redaction for embeddings) because that output is gated by files.embed_sha, a freshness key this fingerprint does not feed -- see embedFingerprintSources() below and tests/guards/parser_fingerprint_covers_extraction_sources.test.ts for the exhaustive classification of every other module reachable from parser.ts. */
export function extractionSources() {
  const files = [
    path.join(ROOT, 'src', 'parser.ts'),
    path.join(ROOT, 'src', 'parser_types.ts'),
    path.join(ROOT, 'src', 'parser_refs.ts'),
    path.join(ROOT, 'src', 'parser_treesitter.ts'),
    path.join(ROOT, 'src', 'parser_structured.ts'),
    path.join(ROOT, 'src', 'language_specs.ts'),
    path.join(ROOT, 'src', 'doc_comment.ts'),
    path.join(ROOT, 'src', 'markdown_lines.ts'),
    path.join(ROOT, 'src', 'section_reader.ts'),
    path.join(ROOT, 'src', 'encoding.ts'),
    path.join(ROOT, 'src', 'constants.ts'),
    path.join(ROOT, 'src', 'util.ts'),
  ]
  const dir = path.join(ROOT, 'src', 'languages')
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) files.push(full)
    }
  }
  walk(dir)
  return files.sort()
}

/** Every source that decides how a file's bytes become embedding chunk text and chunk boundaries: the chunker and search/rerank driver (embeddings.ts), the module that turns already-written symbol/heading rows into chunk boundaries (embedding_boundaries.ts, split out of parser.ts precisely so this fingerprint can hash it without dragging in parse-only code), the dispatcher and every format-specific extractor for binary documents (doc_embed_extract.ts and its pdf/docx/pptx/xlsx/xlsx-reader/ooxml/xml readers -- note csv_query.ts is deliberately NOT in this list, since xlsx_extract.ts's embedding-path function, allSheetsHeadText, never calls queryCsv; that function is reachable only from the CLI-only xlsx-query surface, so hashing it here would be over-broad rather than under-broad), the markdown fence/heading scanning that decides both markdown section boundaries and where a heading is (markdown_lines.ts, hints/markdown_hints.ts), the raw-bytes-to-string decode indexFileEmbeddings runs before redaction and chunking (encoding.ts), dotenv redaction applied before chunking and the language classifier that gates whether it runs at all (dotenv_redact.ts, and parser_types.ts/language_specs.ts/languages/sniff.ts, since detectLanguage()'s 'env_file'/'markdown' verdicts decide both whether redaction applies and which chunk-boundary branch embedding_boundaries.ts takes), the INI quote-continuation helpers dotenv_redact.ts calls to decide which lines a multi-line secret value spans (languages/ini_idx.ts), the base document-refusal type and the one shared work-clock bound it carries (document_refusal.ts, since raising or lowering that bound changes whether a slow-but-completable document is embedded at all), the tokenizer that truncates chunk text to the model's max sequence length before embedding (embed_tokenizer.ts, since a truncation-point change alters what text actually got embedded even though the stored chunk text itself did not move), index_reader.ts's querySymbols, since it is embedding_boundaries.ts's only source of symbol rows and a bug in the query it builds changes which rows a file's boundaries are drawn from, and sql_path.ts's pathEqClause, since it is the equality rule querySymbols filters on and a changed rule yields different or no boundaries even though querySymbols itself did not move. Also hashed: embed_model.ts, specifically because poolAndNormalize (its mean-pool-and-unit-scale step) is the final vector-shaping code that runs after the model's own hidden-state output, living in this repo rather than in the model weights or the backend -- a bug there changes every stored vector while modelName/revision/backendId stay identical, so provenance alone cannot catch it; zip_bounds.ts, whose two limits (enforced by readOoxmlZip in ooxml_extract.ts) decide whether an oversized docx/pptx/xlsx is refused or extracted, i.e. whether it yields chunk text at all; and lazy_module.ts's createLazyModuleLoader, which gates whether the PDF and OOXML extractors load at all, so an edit there can turn document extraction -- and therefore embedding -- on or off. Every other module reachable from these entry points, plus src/parser.ts (indexFileEmbeddings, the real production driver that dispatches to all of the above), is either hashed here or is already hashed by PARSER_FINGERPRINT -- and embedUnchanged in src/worker.ts and src/cli.ts requires parseUnchanged, so a parse-invalidating edit re-embeds the file too, which is why those parse-side modules do not also need a place in this list. See tests/guards/embed_fingerprint_covers_embedding_sources.test.ts for the exhaustive classification. */
export function embedFingerprintSources() {
  return [
    path.join(ROOT, 'src', 'embeddings.ts'),
    path.join(ROOT, 'src', 'embedding_boundaries.ts'),
    path.join(ROOT, 'src', 'index_reader.ts'),
    path.join(ROOT, 'src', 'doc_embed_extract.ts'),
    path.join(ROOT, 'src', 'document_refusal.ts'),
    path.join(ROOT, 'src', 'pdf_extract.ts'),
    path.join(ROOT, 'src', 'docx_extract.ts'),
    path.join(ROOT, 'src', 'pptx_extract.ts'),
    path.join(ROOT, 'src', 'xlsx_extract.ts'),
    path.join(ROOT, 'src', 'xlsx_reader.ts'),
    path.join(ROOT, 'src', 'ooxml_extract.ts'),
    path.join(ROOT, 'src', 'xml_parser.ts'),
    path.join(ROOT, 'src', 'markdown_lines.ts'),
    path.join(ROOT, 'src', 'hints', 'markdown_hints.ts'),
    path.join(ROOT, 'src', 'encoding.ts'),
    path.join(ROOT, 'src', 'dotenv_redact.ts'),
    path.join(ROOT, 'src', 'parser_types.ts'),
    path.join(ROOT, 'src', 'language_specs.ts'),
    path.join(ROOT, 'src', 'languages', 'sniff.ts'),
    path.join(ROOT, 'src', 'languages', 'ini_idx.ts'),
    path.join(ROOT, 'src', 'embed_tokenizer.ts'),
    path.join(ROOT, 'src', 'embed_model.ts'),
    path.join(ROOT, 'src', 'zip_bounds.ts'),
    path.join(ROOT, 'src', 'lazy_module.ts'),
    path.join(ROOT, 'src', 'sql_path.ts'),
  ].sort()
}

function computeFingerprintFor(files) {
  const h = createHash('sha256')
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    // Normalise line endings before hashing. A Windows checkout with core.autocrlf=true holds the
    // same bytes as a Linux one only after that conversion, and a digest that disagreed between a
    // developer's machine and CI would fail the check test on one platform for no real reason.
    const text = fs.readFileSync(file, 'utf8').split('\r\n').join('\n')
    h.update(rel)
    h.update('\0')
    h.update(text)
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

export function computeFingerprint() {
  return computeFingerprintFor(extractionSources())
}

export function computeEmbedFingerprint() {
  return computeFingerprintFor(embedFingerprintSources())
}

function render(name, comment, fingerprint) {
  return [
    `// GENERATED FILE -- do not edit by hand. Run \`npm run parser:fingerprint\` to regenerate.`,
    '//',
    comment,
    `export const ${name} = '${fingerprint}'`,
    '',
  ].join('\n')
}

const PARSER_COMMENT =
  "// A digest of the extraction-decision sources returned by extractionSources() in scripts/parser-fingerprint.mjs, stamped into files.parser_sha alongside the content sha every time a file is indexed. The freshness gates treat a mismatch as changed, so an extraction-logic change invalidates already-indexed files whose content never moved. Before this existed those files kept their old symbols indefinitely, because content was the only key."
const EMBED_COMMENT =
  "// A digest of the embedding-decision sources returned by embedFingerprintSources() in scripts/parser-fingerprint.mjs, folded into embeddingProvenance() (src/embeddings.ts) alongside the model name, its pinned revision, and the inference backend. A mismatch there is treated as a stack change: ensureEmbeddingProvenance discards every stored vector and re-embeds. Before this existed, a chunker or document-extractor change left every already-embedded file's vectors built by the old code indefinitely, because content and model identity were the only keys."

// Only act when run as a command. The guard exists so a test can import computeFingerprint without
// the import itself rewriting a source file or calling process.exit out from under the runner.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

const parserFingerprint = invokedDirectly ? computeFingerprint() : ''
const embedFingerprint = invokedDirectly ? computeEmbedFingerprint() : ''
const wantedParser = render('PARSER_FINGERPRINT', PARSER_COMMENT, parserFingerprint)
const wantedEmbed = render('EMBED_FINGERPRINT', EMBED_COMMENT, embedFingerprint)

function readNormalized(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\r\n').join('\n') : ''
}

if (!invokedDirectly) {
  // Imported for computeFingerprint/computeEmbedFingerprint alone; nothing to do.
} else if (process.argv.includes('--check')) {
  const staleParser = readNormalized(PARSER_OUT) !== wantedParser
  const staleEmbed = readNormalized(EMBED_OUT) !== wantedEmbed
  if (staleParser || staleEmbed) {
    if (staleParser) {
      process.stderr.write(
        'src/parser_fingerprint.ts is stale: the extraction sources changed since it was generated.\n' +
          `Expected PARSER_FINGERPRINT = '${parserFingerprint}'.\n`,
      )
    }
    if (staleEmbed) {
      process.stderr.write(
        'src/embed_fingerprint.ts is stale: the embedding sources changed since it was generated.\n' +
          `Expected EMBED_FINGERPRINT = '${embedFingerprint}'.\n`,
      )
    }
    process.stderr.write('Run `npm run parser:fingerprint`, and say in the CHANGELOG that upgrading reindexes.\n')
    process.exit(1)
  }
  process.stdout.write(`parser fingerprint up to date (${parserFingerprint})\n`)
  process.stdout.write(`embed fingerprint up to date (${embedFingerprint})\n`)
} else {
  fs.writeFileSync(PARSER_OUT, wantedParser)
  fs.writeFileSync(EMBED_OUT, wantedEmbed)
  process.stdout.write(`wrote src/parser_fingerprint.ts (${parserFingerprint})\n`)
  process.stdout.write(`wrote src/embed_fingerprint.ts (${embedFingerprint})\n`)
}

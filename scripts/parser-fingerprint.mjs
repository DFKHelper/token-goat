#!/usr/bin/env node
// Generate (or verify) src/parser_fingerprint.ts and src/embed_fingerprint.ts, the digests of token-goat's two independent freshness keys: what a parse extracts (files.parser_sha) and what the embedding pipeline turns a file's bytes into (files.embed_sha, folded into embeddingProvenance()).
//
// files.sha answers "has this file's content changed since we parsed it". Nothing answered "has what we extract from that content changed", so a parser change left every already-indexed unchanged file pinned to its old symbol set forever: `token-goat index` reported them skipped and they kept stale rows until someone happened to edit each one. Measured on a real index, 37 of 237 source files disagreed with what the same binary produces from scratch, 180 surplus rows in all. The embedding half had the identical hole: files.embed_sha records which content was embedded, never which chunker or document extractor produced the chunk text, so a change to chunkFile, buildEmbeddingBoundaries, or a pdf/docx/pptx/xlsx extractor left every already-embedded file's vectors stale and unreachable by `token-goat index` forever. EMBED_FINGERPRINT closes that half by folding into embeddingProvenance(), whose mismatch path (ensureEmbeddingProvenance) marks every embedded file stale on any change, so it is re-embedded.
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
const LANGUAGES_DIR = path.join(ROOT, 'src', 'languages')

/** The extraction sources outside src/languages/: the driver plus every module that decides which extractor runs and what it yields, for every language at once. None of these belongs to one language, so a change to any of them moves every file's stamp. */
const DECISION_SOURCES = [
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

/** Every source that decides what a parse extracts: the driver, every language adapter, and the modules that pick which extractor runs and what it yields (language/extraction-method detection, tree-sitter node-kind mapping, structured-config extraction, ref extraction, doc comments, and source-encoding decoding, since decodeSource's output is the text every extractor parses). Two grab-bags are in for one export each and cost a reparse on every unrelated edit to them, which is the cheaper half of the trade: constants.ts for SYMBOL_BODY_CHAR_CAP, which bounds every stored symbol body (src/parser.ts's boundSymbolBody and the tree-sitter fan-out elision), and util.ts for countContentLines, which sets line_end for fourteen regex adapters, and escapeRegExp, which builds their patterns. Deliberately excludes: install/bridge/config/db/version/path-identity/env infrastructure that never shapes extracted content, type-only declaration files (erased at compile time), and the document/embedding pipeline (pdf/docx/pptx/xlsx extraction, OCR, chunking, dotenv redaction for embeddings) because that output is gated by files.embed_sha, a freshness key this fingerprint does not feed -- see embedFingerprintSources() below and tests/guards/parser_fingerprint_covers_extraction_sources.test.ts for the exhaustive classification of every other module reachable from parser.ts. */
export function extractionSources() {
  const files = [...DECISION_SOURCES]
  const dir = LANGUAGES_DIR
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

function readSource(file) {
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n')
}

/** Every `from './x.js'` specifier in `file` that resolves to a src/languages/ module, as absolute .ts paths. Relative specifiers pointing out of the directory (`'../parser_types.js'`) resolve to nothing here, which is right: those modules are already decision sources. */
function localImportsOf(file) {
  const out = []
  for (const m of readSource(file).matchAll(/from '(\.[^']*)\.js'/g)) {
    const resolved = path.resolve(path.dirname(file), `${m[1]}.ts`)
    if (resolved.startsWith(`${LANGUAGES_DIR}${path.sep}`) && fs.existsSync(resolved)) out.push(resolved)
  }
  return out
}

/** The two src/languages/ modules that name every adapter by construction -- the dispatch table and the re-export barrel. Both are shared (nothing one language owns), but their import edges are followed only when the walk starts inside ADAPTER_EXTRACTORS: expanding them from the shared side would drag the whole directory into the shared digest and put the stamp straight back to one global value. */
const HUB_MODULES = [path.join(LANGUAGES_DIR, 'registry.ts'), path.join(LANGUAGES_DIR, 'index.ts')]

/** `seeds` plus everything they import, transitively, within src/languages/. An extractor's reach is what decides whether an edit under that directory can change what it produces, so the closure -- not the one module named at the call site -- is what a language owns. `stopAt` members are included but not expanded. */
function closureOf(seeds, stopAt = []) {
  const seen = new Set()
  const queue = [...seeds]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!stopAt.includes(file)) queue.push(...localImportsOf(file))
  }
  return seen
}

/** Imported identifier -> the src/languages/ module it came from, for one module's own import statements. Aliased and `type`-only specifiers included: an identifier that turns out to be neither reachable nor used costs an entry nobody looks up. */
function importedIdentifierModules(file) {
  const out = new Map()
  for (const m of readSource(file).matchAll(/import (?:type )?\{([^}]*)\} from '(\.[^']*)\.js'/g)) {
    const resolved = path.resolve(path.dirname(file), `${m[2]}.ts`)
    if (!resolved.startsWith(`${LANGUAGES_DIR}${path.sep}`) || !fs.existsSync(resolved)) continue
    for (const spec of m[1].split(',')) {
      const name = spec.trim().replace(/^type /, '').split(/ as /).pop()?.trim()
      if (name !== undefined && name !== '') out.set(name, resolved)
    }
  }
  return out
}

/** `[language, valueText]` for each top-level property of an object literal declared as `name`, scanned with string and comment awareness so a brace inside a string or a comma inside a nested call does not split an entry. Throws rather than guessing when the literal cannot be found: a silently empty result would attribute every adapter to nobody and quietly widen every digest back to today's global one. */
function objectLiteralEntries(text, name) {
  const declared = text.indexOf(`export const ${name}`)
  if (declared === -1) throw new Error(`${name} not found`)
  const open = text.indexOf('{', text.indexOf('=', declared))
  const entries = []
  let depth = 0
  let start = open + 1
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) {
        entries.push(text.slice(start, i))
        return entries.map(splitProperty).filter((e) => e !== null)
      }
    } else if (c === ',' && depth === 1) {
      entries.push(text.slice(start, i))
      start = i + 1
    }
  }
  throw new Error(`${name} object literal is unterminated`)
}

function splitProperty(chunk) {
  const body = chunk.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '')
  const colon = body.indexOf(':')
  if (colon === -1) return null
  const key = body.slice(0, colon).trim().replace(/^'|'$/g, '')
  return /^\w+$/.test(key) ? [key, body.slice(colon + 1)] : null
}

/** Every `language: extractor` property of ADAPTER_EXTRACTORS, as read out of src/languages/registry.ts. Exported so a test can check the keys this parse found against the keys the compiled object really has: a split that silently dropped an entry would attribute that adapter to nobody and widen its language's digest back to the shared one, which is invisible in the generated file. */
export function adapterDispatchEntries() {
  return objectLiteralEntries(readSource(path.join(LANGUAGES_DIR, 'registry.ts')), 'ADAPTER_EXTRACTORS')
}

/** Which src/languages/ modules exactly one language's extractor can reach, keyed by the id stored in `files.language`. Derived from ADAPTER_EXTRACTORS in src/languages/registry.ts -- the table the parser actually dispatches through -- rather than from a second hand-written mapping, because a stamp that attributes a file differently from the parser that indexed it is how a row keeps stale symbols with nothing to signal it. Three kinds of module are deliberately left out and fall to sharedExtractionSources() instead: one two or more extractors reach (common.ts, shader.ts, templates_idx.ts), one no extractor reaches (registry.ts's own dispatch table, index.ts), and one a decision source imports directly -- sniff.ts is the load-bearing case, since parser_types.ts's refineLanguageByContent calls it to decide whether a .cls is Apex, VB6 or ABL, so an edit there changes which adapter parses a file already stamped for another. Over-invalidating costs a reparse; under-invalidating leaves wrong symbols in the index indefinitely, which is the failure files.parser_sha exists to close. */
export function languageExtractionSources() {
  const registry = path.join(LANGUAGES_DIR, 'registry.ts')
  const identifierModules = importedIdentifierModules(registry)
  const reach = new Map()
  for (const [language, value] of adapterDispatchEntries()) {
    const seeds = [...value.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => identifierModules.get(m[0])).filter((m) => m !== undefined)
    for (const file of closureOf(seeds)) reach.set(file, (reach.get(file) ?? new Set()).add(language))
  }
  const sharedReach = closureOf(DECISION_SOURCES.flatMap((f) => localImportsOf(f)), HUB_MODULES)
  const owned = new Map()
  for (const [file, languages] of [...reach].sort()) {
    if (languages.size !== 1 || sharedReach.has(file)) continue
    const language = [...languages][0]
    owned.set(language, [...(owned.get(language) ?? []), file])
  }
  return new Map([...owned].sort())
}

/** The extraction sources no single language owns: {@link DECISION_SOURCES} plus every src/languages/ module {@link languageExtractionSources} left unattributed. This is what PARSER_FINGERPRINT digests, so it is also the stamp a file gets when its language has no adapter of its own -- tree-sitter languages, the structured-document formats parser.ts extracts inline, and `unknown`. */
export function sharedExtractionSources() {
  const owned = new Set([...languageExtractionSources().values()].flat())
  return extractionSources().filter((f) => !owned.has(f))
}

/** Every source that decides how a file's bytes become embedding chunk text and chunk boundaries: the chunker and search/rerank driver (embeddings.ts), the module that turns already-written symbol/heading rows into chunk boundaries (embedding_boundaries.ts, split out of parser.ts precisely so this fingerprint can hash it without dragging in parse-only code), the dispatcher and every format-specific extractor for binary documents (doc_embed_extract.ts and its pdf/docx/pptx/xlsx/xlsx-reader/ooxml/xml readers -- note csv_query.ts is deliberately NOT in this list, since xlsx_extract.ts's embedding-path function, allSheetsHeadText, never calls queryCsv; that function is reachable only from the CLI-only xlsx-query surface, so hashing it here would be over-broad rather than under-broad), the markdown fence/heading scanning that decides both markdown section boundaries and where a heading is (markdown_lines.ts, hints/markdown_hints.ts), the raw-bytes-to-string decode indexFileEmbeddings runs before redaction and chunking (encoding.ts), dotenv redaction applied before chunking and the language classifier that gates whether it runs at all (dotenv_redact.ts, and parser_types.ts/language_specs.ts/languages/sniff.ts, since detectLanguage()'s 'env_file'/'markdown' verdicts decide both whether redaction applies and which chunk-boundary branch embedding_boundaries.ts takes), the INI quote-continuation helpers dotenv_redact.ts calls to decide which lines a multi-line secret value spans (languages/ini_idx.ts), the base document-refusal type and the one shared work-clock bound it carries (document_refusal.ts, since raising or lowering that bound changes whether a slow-but-completable document is embedded at all), the tokenizer that truncates chunk text to the model's max sequence length before embedding (embed_tokenizer.ts, since a truncation-point change alters what text actually got embedded even though the stored chunk text itself did not move), index_reader.ts's querySymbols, since it is embedding_boundaries.ts's only source of symbol rows and a bug in the query it builds changes which rows a file's boundaries are drawn from, and sql_path.ts's pathEqClause, since it is the equality rule querySymbols filters on and a changed rule yields different or no boundaries even though querySymbols itself did not move. Also hashed: embed_model.ts, specifically because poolAndNormalize (its mean-pool-and-unit-scale step) is the final vector-shaping code that runs after the model's own hidden-state output, living in this repo rather than in the model weights or the backend -- a bug there changes every stored vector while modelName/revision/backendId stay identical, so provenance alone cannot catch it; zip_bounds.ts, whose two limits (enforced by readOoxmlZip in ooxml_extract.ts) decide whether an oversized docx/pptx/xlsx is refused or extracted, i.e. whether it yields chunk text at all; and lazy_module.ts's createLazyModuleLoader, which gates whether the PDF and OOXML extractors load at all, so an edit there can turn document extraction -- and therefore embedding -- on or off. Every other module reachable from these entry points, plus src/parser.ts (indexFileEmbeddings, the real production driver that dispatches to all of the above), is either hashed here or is already hashed by PARSER_FINGERPRINT. What keeps that second bucket safe is NOT that embedUnchanged requires parseUnchanged: it has not since the two gates were decoupled (see the comment on embedUnchanged in src/cli.ts for why conjoining them re-embedded the whole index on every parser-stamp bump). It is that a parse-side edit can only reach embedding through the symbol rows a file's chunk boundaries are drawn from, and writeParseResult (src/parser.ts, via embeddingBoundariesMoved) compares those boundaries across every reparse and drops the file's embed stamp when they moved -- so an adapter edit re-embeds exactly the files whose own cuts changed, without moving this global digest, which would re-embed every already-embedded file on the machine. See tests/guards/embed_fingerprint_covers_embedding_sources.test.ts for the exhaustive classification. */
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

/** The embedding-decision sources exactly one extraction kind can reach, keyed by the kind id embedKindForPath() in src/embed_stamp.ts resolves a file to. A kind is a set of files whose only way to change what gets embedded runs through one document format: pdf_extract.ts can only alter a PDF's text, hints/markdown_hints.ts only the heading boundaries embedding_boundaries.ts draws for a file detectLanguage() calls markdown, and the OOXML trio (ooxml_extract.ts, xml_parser.ts, zip_bounds.ts) only the three zip-container formats that read through it -- a standalone .xml file is embedded from its own bytes by encoding.ts, which is global. Everything NOT here stays in {@link embedGlobalSources}, and one class of file must never be moved out of it: anything that can reclassify a file's language. That is the whole safety argument for skipping a re-embed -- a change that could send a file to a different chunker moves the global digest, which moves every kind digest with it -- and it is why the six sources this list's siblings share with sharedExtractionSources() (encoding.ts, language_specs.ts, languages/ini_idx.ts, languages/sniff.ts, markdown_lines.ts, parser_types.ts) are global however kind-specific one of them reads. tests/guards/embed_kind_partition.test.ts fails if any of them turns up here. */
export function embedKindSources() {
  const src = (...parts) => path.join(ROOT, 'src', ...parts)
  const ooxml = [src('ooxml_extract.ts'), src('xml_parser.ts'), src('zip_bounds.ts')]
  return new Map([
    ['docx', [src('docx_extract.ts'), ...ooxml]],
    ['markdown', [src('hints', 'markdown_hints.ts')]],
    ['pdf', [src('pdf_extract.ts')]],
    ['pptx', [src('pptx_extract.ts'), ...ooxml]],
    ['xlsx', [src('xlsx_extract.ts'), src('xlsx_reader.ts'), ...ooxml]],
  ])
}

/** The embedding-decision sources no single extraction kind owns: {@link embedFingerprintSources} minus everything {@link embedKindSources} claims. This is what EMBED_FINGERPRINT digests, so it is the stamp carried by every file whose kind has no bucket of its own -- source code, plain text, a standalone .xml or .csv -- and it is folded into each kind's digest as well, so a chunker change still invalidates every kind at once. */
export function embedGlobalSources() {
  const owned = new Set([...embedKindSources().values()].flat())
  return embedFingerprintSources().filter((f) => !owned.has(f))
}

function computeFingerprintFor(files) {
  const h = createHash('sha256')
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    // Normalise line endings before hashing. A Windows checkout with core.autocrlf=true holds the same bytes as a Linux one only after that conversion, and a digest that disagreed between a developer's machine and CI would fail the check test on one platform for no real reason.
    const text = fs.readFileSync(file, 'utf8').split('\r\n').join('\n')
    h.update(rel)
    h.update('\0')
    h.update(text)
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

export function computeFingerprint() {
  return computeFingerprintFor(sharedExtractionSources())
}

/** Language id -> the digest of that language's own adapter modules together with every shared source, so an edit under src/languages/<lang> moves this one entry and leaves every other language's digest byte-identical. Only languages with a module of their own appear; every other language is stamped with {@link computeFingerprint}'s shared digest. */
export function computeLanguageFingerprints() {
  const shared = sharedExtractionSources()
  return new Map([...languageExtractionSources()].map(([language, files]) => [language, computeFingerprintFor([...shared, ...files].sort())]))
}

export function computeEmbedFingerprint() {
  return computeFingerprintFor(embedGlobalSources())
}

/** Extraction kind -> the digest of that kind's own sources together with every global one, so an edit to a document extractor moves this one entry and leaves every other kind's digest byte-identical, while an edit to the chunker moves all of them. Same shape as {@link computeLanguageFingerprints}, for the same reason. */
export function computeEmbedKindFingerprints() {
  const global = embedGlobalSources()
  return new Map([...embedKindSources()].map(([kind, files]) => [kind, computeFingerprintFor([...global, ...files].sort())]))
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

function renderParser(fingerprint, languageFingerprints) {
  return [
    render('PARSER_FINGERPRINT', PARSER_COMMENT, fingerprint).trimEnd(),
    '',
    LANGUAGE_COMMENT,
    'export const LANGUAGE_PARSER_FINGERPRINTS: ReadonlyMap<string, string> = new Map([',
    ...[...languageFingerprints].map(([language, digest]) => `  ['${language}', '${digest}'],`),
    '])',
    '',
  ].join('\n')
}

function renderEmbed(fingerprint, kindFingerprints) {
  return [
    render('EMBED_FINGERPRINT', EMBED_COMMENT, fingerprint).trimEnd(),
    '',
    EMBED_KIND_COMMENT,
    'export const EMBED_KIND_FINGERPRINTS: ReadonlyMap<string, string> = new Map([',
    ...[...kindFingerprints].map(([kind, digest]) => `  ['${kind}', '${digest}'],`),
    '])',
    '',
    PRE_KIND_COMMENT,
    `export const PRE_KIND_EMBED_FINGERPRINT = '${PRE_KIND_EMBED_FINGERPRINT}'`,
    '',
    SPLIT_COMMENT,
    `export const SPLIT_EMBED_FINGERPRINT = '${SPLIT_EMBED_FINGERPRINT}'`,
    '',
  ].join('\n')
}

/** The single whole-set digest EMBED_FINGERPRINT carried before it was split into a global digest plus per-kind ones, frozen as a literal because it cannot be recomputed from these sources: the split itself edited embeddings.ts, one of the files it hashed. It is the value v2.9.18 shipped (`git show v2.9.18:src/embed_fingerprint.ts`), and ensureEmbeddingProvenance reads a database stamped with exactly it as already agreeing with every stamp below -- see the reasoning there. */
const PRE_KIND_EMBED_FINGERPRINT = 'b7b2ff71de288d13'

/** The value EMBED_FINGERPRINT took when the per-kind split landed, frozen by hand rather than emitted as `embedFingerprint` so that it stops tracking it: resetStaleChunking grandfathers a {@link PRE_KIND_EMBED_FINGERPRINT} database only while the running build still carries this digest, which is the premise the clause rests on (nothing between those two digests produces chunk text). The first edit to a global embedding source moves EMBED_FINGERPRINT away from this literal, the clause lapses, and those databases are re-embedded by the ordinary moved-global-digest path. Deliberately not recomputed after an unrelated edit to a hashed source: that only retires the clause early, which costs one re-embed and is the safe direction. Both constants can be deleted, along with the first conjunct of that clause, once no database stamped by v2.9.18 or earlier is plausible. */
const SPLIT_EMBED_FINGERPRINT = '2310db32d9bc8a2b'

const PRE_KIND_COMMENT =
  "// The single whole-set digest EMBED_FINGERPRINT carried before the split above, shipped by v2.9.18 and every release before it. Frozen as a literal in scripts/parser-fingerprint.mjs rather than computed, because the split edited embeddings.ts, one of the sources that digest hashed. ensureEmbeddingProvenance treats a database stamped with exactly this value, in the same vector space, as already agreeing with every stamp above, so the upgrade re-embeds nothing; any other stored digest is re-embedded as before."
const SPLIT_COMMENT =
  "// The value EMBED_FINGERPRINT held when the split above landed, frozen as a literal in scripts/parser-fingerprint.mjs so that it does not follow it. resetStaleChunking grandfathers a PRE_KIND_EMBED_FINGERPRINT database only while this build's global digest is still this one, because that is what makes the grandfathering true: nothing that produces chunk text changed between the two. The first edit to a global embedding source moves EMBED_FINGERPRINT off this value, the clause lapses on its own, and a database that skipped the intervening releases is re-embedded by the ordinary moved-global-digest path instead of keeping vectors the new chunker invalidated. This constant and PRE_KIND_EMBED_FINGERPRINT can both be deleted once no database stamped by v2.9.18 or earlier is plausible."
const PARSER_COMMENT =
  "// A digest of the shared extraction-decision sources returned by sharedExtractionSources() in scripts/parser-fingerprint.mjs -- the driver and every module that decides extraction for all languages at once. It is the stamp files.parser_sha carries for a file whose language has no adapter module of its own (the tree-sitter languages, the structured-document formats parser.ts extracts inline, and 'unknown'), and the fallback for any language missing from LANGUAGE_PARSER_FINGERPRINTS below. The freshness gates treat a mismatch as changed, so an extraction-logic change invalidates already-indexed files whose content never moved. Before this existed those files kept their old symbols indefinitely, because content was the only key."
const LANGUAGE_COMMENT =
  "// Per-language digests, each over the shared sources above plus that language's own adapter modules under src/languages/. Keyed by the id stored in files.language, which is what the gates look a stamp up by -- see parserFingerprintForLanguage() in src/parser_stamp.ts. A fix to one adapter moves one entry here, so only that language's already-indexed files are reparsed; before this was per-language, a Dart adapter fix reparsed every file in every project, including projects holding no Dart at all."
const EMBED_COMMENT =
  "// A digest of the global embedding-decision sources returned by embedGlobalSources() in scripts/parser-fingerprint.mjs -- the chunker and every module that decides embedding for all kinds at once -- folded into embeddingProvenance() (src/embeddings.ts) alongside the model name, its pinned revision, and the inference backend. A mismatch in this half alone keeps the stored vectors serving, since the model and runtime still share their space, and marks every embedded file stale so reconcile and `token-goat index` re-embed it. Before this existed, a chunker or document-extractor change left every already-embedded file's vectors built by the old code indefinitely, because content and model identity were the only keys."
const EMBED_KIND_COMMENT =
  "// Per-kind digests, each over the global sources above plus that extraction kind's own. Keyed by the kind embedKindForPath() in src/embed_stamp.ts resolves a file to, which is what ensureEmbeddingProvenance scopes a re-embed by. A change to one document extractor moves one entry here, so only that format's already-embedded files are re-embedded; before this was per-kind, an edit to pdf_extract.ts re-embedded every file on the machine -- 243,238 chunks across 17,876 files on one real index."

// Only act when run as a command. The guard exists so a test can import computeFingerprint without the import itself rewriting a source file or calling process.exit out from under the runner.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

const parserFingerprint = invokedDirectly ? computeFingerprint() : ''
const embedFingerprint = invokedDirectly ? computeEmbedFingerprint() : ''
const wantedParser = renderParser(parserFingerprint, invokedDirectly ? computeLanguageFingerprints() : new Map())
const wantedEmbed = renderEmbed(embedFingerprint, invokedDirectly ? computeEmbedKindFingerprints() : new Map())

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

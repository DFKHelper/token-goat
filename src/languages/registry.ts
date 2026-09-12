/**
 * The regex language adapters and the table that dispatches to them.
 *
 * parser.ts reaches this module only through loadRegexExtractors()'s dynamic import, so the adapters load where files are
 * parsed (the CLI, the worker, parseFile) and never on the hook path. Nothing on the hook path may import it statically:
 * tests/guards/dist_chunks_deduped.test.ts fails when an adapter lands in the hook's eager set.
 */

import type { RegexLanguage } from '../language_specs.js'
import type { SymbolEntry } from '../parser_types.js'
import { assignBraceBlockSpans } from './common.js'
import { extractCsharp } from './csharp.js'
import { extractPhp, maskPhpInlineHtml } from './php.js'
import { extractHtml } from './html.js'
import { extractLiquid } from './liquid.js'
import { extractKotlin } from './kotlin.js'
import { extractSwift } from './swift.js'
import { extractScala } from './scala.js'
import { extractLua } from './lua.js'
import { extractVb } from './vb.js'
import { extractCobol } from './cobol.js'
import { extractNatural } from './natural.js'
import { extractAbap } from './abap.js'
import { extractAbl } from './abl.js'
import { extractJcl } from './jcl.js'
import { extractPli } from './pli.js'
import { extractRpg } from './rpg.js'
import { extractSas } from './sas.js'
import { extractGroovy } from './groovy.js'
import { extractObjc } from './objc.js'
import { extractPerl } from './perl.js'
import { extractCShader, extractWgsl } from './shader.js'
import { extractSolidity } from './solidity.js'
import { extractThrift } from './thrift.js'
import { extractFortran } from './fortran.js'
import { extractPascal } from './pascal.js'
import { extractMatlab } from './matlab.js'
import { extractCmake } from './cmake.js'
import { extractAsm } from './asm.js'
import { extractBatch } from './batch.js'
import { extractErlang } from './erlang.js'
import { extractVhdl } from './vhdl.js'
import { extractElixir } from './elixir.js'
import { extractDart } from './dart.js'
import { extractZig } from './zig.js'
import { extractR } from './r.js'
import { extractGraphql } from './graphql_idx.js'
import { extractSql } from './sql_idx.js'
import { extractIni, extractEnv } from './ini_idx.js'
import { extractBash } from './bash_idx.js'
import { extractMakefile } from './makefile_idx.js'
import { extractProto } from './proto_idx.js'
import { extractTerraform } from './terraform_idx.js'
import { extractPowershell } from './powershell_idx.js'
import { extractApex } from './apex.js'
import { extractSalesforceMetadata } from './salesforce_metadata.js'
import { extractVue, extractSvelte, extractAstro } from './sfc_idx.js'
import { extractJinja2, extractHandlebars, extractErb, extractEjs, extractNunjucks, extractTwig } from './templates_idx.js'

export { extractCobol, extractNatural, extractSalesforceMetadata, extractVue, extractSvelte, extractAstro }

type SymbolExtractor = (content: string, filePath: string) => SymbolEntry[]

/** The regex rows whose extractors live in parser.ts itself: the structured-document formats. */
type ParserRegexLanguage = 'markdown' | 'json' | 'yaml' | 'toml' | 'css' | 'dockerfile'

/**
 * Map an adapter's parsed `.sections` (heading, level, line, endLine) into indexable
 * SymbolEntry rows. HTML and Liquid compute headings into `.sections` for the section-outline
 * consumer but historically never surfaced them as symbols, so they never entered the index
 * and were unreachable via `symbol`/`skeleton`/`outline` -- unlike markdown/proto/graphql/sql,
 * which push headings into both symbols and sections via makeSymbolEmitter.
 */
function sectionsToHeadingSymbols(
  sections: ReadonlyArray<{ heading: string; level: number; line: number; endLine: number }>,
  filePath: string,
): SymbolEntry[] {
  return sections.map((s) => ({
    filePath,
    name: s.heading,
    kind: 'heading',
    lineStart: s.line,
    lineEnd: s.endLine,
    body: '',
    docstring: '',
    parent: '',
  }))
}

// One entry per adapter-backed `regex` row of src/language_specs.ts, required by the type: a new row without an extractor fails the type check. html/liquid keep their extra sectionsToHeadingSymbols composition inline.
export const ADAPTER_EXTRACTORS: Record<Exclude<RegexLanguage, ParserRegexLanguage>, SymbolExtractor> = {
  csharp: (content, filePath) => assignBraceBlockSpans(extractCsharp(content, filePath).symbols, content, { lineComment: '//', stringEscapes: 'csharp', rawStringQuotes: true }),
  // Both halves walk the SAME masked text: the brace pass used to span raw file content, so it nested on braces in the inline HTML the extractor is no longer reading.
  php: (content, filePath) => {
    const code = maskPhpInlineHtml(content)
    return assignBraceBlockSpans(extractPhp(code, filePath).symbols, code, { lineComment: ['//', '#'], lineCommentExceptions: ['#['], multilineLang: 'php' })
  },
  html: (content, filePath) => {
    const r = extractHtml(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  liquid: (content, filePath) => {
    const r = extractLiquid(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  // The six template dialects mask their own delimiters out and hand off to extractHtml, so they
  // compose the same way html/liquid do above -- see templates_idx.ts's module doc for why this
  // is the one place in Batch G/F where sharing IS correct.
  jinja2: (content, filePath) => {
    const r = extractJinja2(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  handlebars: (content, filePath) => {
    const r = extractHandlebars(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  erb: (content, filePath) => {
    const r = extractErb(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  ejs: (content, filePath) => {
    const r = extractEjs(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  nunjucks: (content, filePath) => {
    const r = extractNunjucks(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  twig: (content, filePath) => {
    const r = extractTwig(content, filePath)
    return [...r.symbols, ...sectionsToHeadingSymbols(r.sections, filePath)]
  },
  kotlin: (content, filePath) => assignBraceBlockSpans(extractKotlin(content, filePath).symbols, content, { lineComment: '//', nestedBlockComments: true, tripleQuote: true, tripleQuoteRunClose: 'last' }),
  swift: (content, filePath) => assignBraceBlockSpans(extractSwift(content, filePath).symbols, content, { lineComment: '//', nestedBlockComments: true, tripleQuote: true, tripleQuoteRunClose: 'last', multilineLang: 'swift' }),
  scala: (content, filePath) => assignBraceBlockSpans(extractScala(content, filePath).symbols, content, { lineComment: '//', nestedBlockComments: true, tripleQuote: true, tripleQuoteRunClose: 'last' }),
  lua: (content, filePath) => extractLua(content, filePath).symbols,
  vb: (content, filePath) => extractVb(content, filePath).symbols,
  elixir: (content, filePath) => extractElixir(content, filePath).symbols,
  dart: (content, filePath) => assignBraceBlockSpans(extractDart(content, filePath).symbols, content, { lineComment: '//', nestedBlockComments: true, tripleQuote: true, tripleSingleQuote: true, tripleQuoteRunClose: 'first' }),
  zig: (content, filePath) => assignBraceBlockSpans(extractZig(content, filePath).symbols, content, { lineComment: '//', blockComment: null, lineStringPrefix: '\\\\' }),
  r: (content, filePath) => extractR(content, filePath).symbols,
  graphql: (content, filePath) => extractGraphql(content, filePath).symbols,
  sql: extractSql,
  ini: extractIni,
  makefile: extractMakefile,
  proto: (content, filePath) => extractProto(content, filePath).symbols,
  terraform: extractTerraform,
  powershell: (content, filePath) => assignBraceBlockSpans(extractPowershell(content, filePath).symbols, content, { lineComment: '#', stringEscapes: 'powershell', multilineLang: 'powershell' }),
  apex: (content, filePath) => extractApex(content, filePath).symbols,
  salesforce_metadata: (content, filePath) => extractSalesforceMetadata(content, filePath).symbols,
  env_file: extractEnv,
  bash: extractBash,
  abap: (content, filePath) => extractAbap(content, filePath).symbols,
  sas: (content, filePath) => extractSas(content, filePath).symbols,
  pli: (content, filePath) => extractPli(content, filePath).symbols,
  rpg: (content, filePath) => extractRpg(content, filePath).symbols,
  jcl: (content, filePath) => extractJcl(content, filePath).symbols,
  abl: (content, filePath) => extractAbl(content, filePath).symbols,
  objc: (content, filePath) => extractObjc(content, filePath).symbols,
  groovy: (content, filePath) => extractGroovy(content, filePath).symbols,
  perl: (content, filePath) => extractPerl(content, filePath).symbols,
  solidity: (content, filePath) => extractSolidity(content, filePath).symbols,
  thrift: (content, filePath) => extractThrift(content, filePath).symbols,
  glsl: (content, filePath) => extractCShader(content, filePath).symbols,
  hlsl: (content, filePath) => extractCShader(content, filePath).symbols,
  metal: (content, filePath) => extractCShader(content, filePath).symbols,
  wgsl: (content, filePath) => extractWgsl(content, filePath).symbols,
  fortran: (content, filePath) => extractFortran(content, filePath).symbols,
  pascal: (content, filePath) => extractPascal(content, filePath).symbols,
  matlab: (content, filePath) => extractMatlab(content, filePath).symbols,
  cmake: (content, filePath) => extractCmake(content, filePath).symbols,
  asm: (content, filePath) => extractAsm(content, filePath).symbols,
  batch: (content, filePath) => extractBatch(content, filePath).symbols,
  erlang: (content, filePath) => extractErlang(content, filePath).symbols,
  vhdl: (content, filePath) => extractVhdl(content, filePath).symbols,
}

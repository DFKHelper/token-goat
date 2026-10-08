/** Brace-span pass shared by the regex language adapters: finds the block a declaration opens and the line that closes it. Lives apart from common.ts so the hook entry, which needs only the line and comment helpers there, does not load it. */

import type { SymbolEntry } from '../parser_types.js'
import { buildLineIndex, closingQuoteRunEnd, lineTextAt, matchRRawOpener, offsetToLine, scalaCharLiteralLength, stripMultilineStringSpan, type MultilineStringLang, type MultilineStringState, type QuoteRunClose } from './common.js'

/** Find the line of the closing brace that matches the `{` at `openBraceIndex`, by walking forward from that offset and tracking brace depth. Used by adapters (proto_idx, terraform_idx) whose blocks can nest arbitrarily (a message can contain another message, a resource can contain a lifecycle block, ...), where the shared assignFlatEndLines/propagateEndLinesToSymbols flat "ends where the next section starts" propagation is wrong: an outer block's end gets truncated to right before its first nested child, and an innermost/last-in-file nested block over-extends to EOF instead of stopping at its own closing brace. Since each caller's regex ends with `\{`, the opening brace's offset is already known, making a true matching-brace walk possible. Tracks single/double-quoted string literals (backslash-escape aware) so a brace character inside a quoted value (e.g. `default = "{}"`, `option (x) = "{"`) is never miscounted as real nesting. Returns `totalLines` if the brace is never closed. */
/** Per-language options for {@link assignBraceBlockSpans}. Named rather than positional because the set grew past what a reader can keep straight in a call like `(syms, src, '//', 'backslash', true, true)`. */
export interface BraceSpanOpts {
  /** The language's line-comment prefixes, e.g. `'//'`, or `['//', '#']` for PHP, which has both. */
  lineComment?: string | readonly string[]
  /** See {@link BraceScanOpts.lineCommentExceptions}. */
  lineCommentExceptions?: readonly string[]
  /** Block-comment delimiters. Omit to derive them from {@link lineComment} (`'//'` gives C-style, `'#'` gives PowerShell's `<# #>`); pass `null` for a language that has no block comment at all. */
  blockComment?: readonly [string, string] | null
  /** See {@link BraceScanOpts.stringEscapes}. */
  stringEscapes?: NonNullable<BraceScanOpts['stringEscapes']>
  /** See {@link BraceScanOpts.nestedBlockComments}. */
  nestedBlockComments?: boolean
  /** See {@link BraceScanOpts.tripleQuote}. */
  tripleQuote?: boolean
  /** See {@link BraceScanOpts.tripleSingleQuote}. */
  tripleSingleQuote?: boolean
  /** See {@link BraceScanOpts.tripleQuoteRunClose}. */
  tripleQuoteRunClose?: QuoteRunClose
  /** See {@link BraceScanOpts.rawStringQuotes}. */
  rawStringQuotes?: boolean
  /** See {@link BraceScanOpts.rRawStrings}. */
  rRawStrings?: boolean
  /** See {@link BraceScanOpts.lineStringPrefix}. */
  lineStringPrefix?: string
  /** See {@link BraceScanOpts.symbolLiterals}. */
  symbolLiterals?: boolean
  /** Blank this language's multi-line-capable string literals before walking braces, via {@link maskMultilineStrings}. The per-literal {@link BraceScanOpts} flags cover the forms whose delimiters are fixed; this covers the ones whose closer is decided by the opener, which a character-at-a-time walk cannot recognise: a PHP heredoc (`<<<EOT`) and a Swift raw string (`#"..."#`). A `}` inside either is text, and without this it decrements the brace depth and ends the enclosing function at that line. The extractors for those languages already mask with the same function to find declarations, so this makes the span walk read the same text they did. */
  multilineLang?: MultilineStringLang
  /** See {@link BraceScanOpts.interpolation}. */
  interpolation?: InterpolationLang
  /** Span a C# expression-bodied member (`=> expr;`) through its terminating `;` at bracket depth 0, however many lines the expression takes, instead of leaving it on its first line. `'kotlin'` ends an `= expr` body (Kotlin's `fun f() = expr`, Scala's `def f = expr`) where the expression ends, so the brace search never runs past it into an unrelated block. */
  expressionBodies?: boolean | 'kotlin'
}

/** Opt-in extras for {@link findMatchingBraceEndLine}. Each defaults to the pre-existing behaviour, so the many callers that pass none are byte-for-byte unaffected. */
export interface BraceScanOpts {
  /** Block-comment delimiters, e.g. `['/*', '*\/']` for C-style or `['<#', '#>']` for PowerShell. When set, a brace inside such a span is ignored -- the same reason line comments are skipped. Without this, a stray `{` or `}` in a `/* ... *\/` comment corrupts the depth walk (a comment brace on the signature line made the whole symbol fail to widen). */
  blockComment?: readonly [string, string]
  /** The scanned symbol is a type, whose header may legally continue on a line starting with a member-start word (`class A` then `constructor(x: Int) {`). */
  typeHeader?: boolean
  /** Value to return when no matching close brace is found before end-of-content. Defaults to `totalLines`, which every existing caller relies on. {@link assignBraceBlockSpans} passes `-1` so an unbalanced brace yields no span at all rather than a bogus span running to EOF. */
  noMatchValue?: number
  /** Treat a backtick as a string/identifier delimiter, alongside `"` and `'`. R quotes identifiers with backticks and such a name may legally contain `{`, `}`, or `#`; without this a `}` inside a backtick identifier decrements the brace depth and ends the span early. Opt-in because in most languages a backtick is not a delimiter (e.g. a JS template literal has its own `${}` nesting a plain scan cannot handle), so only callers whose language uses backtick this way should set it. */
  backtickQuote?: boolean
  /** Which string-escape model the scan applies inside a quoted span. `'backslash'` (the default, and what every pre-existing caller gets) treats `\` as escaping the next character, which is right for the C family. `'powershell'` is for PowerShell, where `\` is an ordinary character inside a string -- so a Windows path literal like `"C:\temp\"` really does end at that quote, and reading the `\"` as an escaped quote left the string "open" and swallowed every brace after it -- and the real escape is a backtick, valid only inside a double-quoted string, with a doubled quote (`""` or `''`) escaping the delimiter in either kind. `'csharp'` keeps backslash escapes for ordinary literals but also recognizes a verbatim string (`@"..."`, `$@"..."`, `@$"..."`), inside which `\` is literal and a doubled `""` is the escaped quote. */
  stringEscapes?: 'backslash' | 'powershell' | 'csharp'
  /** Whether the language's block comments nest, so an inner opener inside a block comment must be counted rather than ignored. Kotlin, Swift, Scala and Dart all specify nesting comments; C, C++, C#, Java, PHP and PowerShell do not, and for those a first-closer scan is correct. Scanning a nesting language without this ends the comment at the inner closer, so the text after it -- including a `}` that is really still commented out -- is read as code and the enclosing symbol's span stops early. */
  nestedBlockComments?: boolean
  /** Whether `"""` opens a triple-quoted string that runs, verbatim, to the next `"""`. Kotlin, Scala, Swift and Dart all have one; C, C++, C#, Java, PHP and PowerShell do not, and for those three adjacent quotes mean something else entirely. Without this the scan reads `"""` as three ordinary quotes, so a lone `"` inside the literal (`"""5" wide"""`) flips the walk's idea of what is code, and a trailing backslash (`"""C:\Users\"""`, legal because these literals take no escapes) reads as an escaped quote and swallows the rest of the file -- either way the enclosing symbol never gets its block span. */
  tripleQuote?: boolean
  /** Scala: a `'` that does not open a character literal (`'sym`) is an ordinary character, not a string opener, and a character literal (`'"'`, `'{'`) is skipped whole. Without it a lone symbol literal opens a quote that swallows the rest of the file. */
  symbolLiterals?: boolean
  /** A prefix that opens a string literal running to the end of the line, with no escape sequences and no closing delimiter. Zig's multi-line string is written as a `\\` at the start of each line; its content is arbitrary text, so a `}` inside one is not a brace. Without this the scan reads that content as code and the enclosing symbol's span ends at the first `}` the text happens to contain. */
  lineStringPrefix?: string
  /** Literals that begin with a line-comment prefix but are not a comment, checked first so the prefix does not match them. PHP 8 spells an attribute `#[Attr]`, which starts with its `#` comment prefix; treating it as a comment skips to end of line and loses an opening brace that shares the line, as in `function f(#[SensitiveParameter] string $p) {`. */
  lineCommentExceptions?: readonly string[]
  /** Whether a run of three or more """ opens a C# 11 raw string literal, closed by the next run of at least that many quotes. Unlike {@link tripleQuote} the delimiter length is not fixed: four opening quotes are closed by four, which is how a literal containing three quotes is written. Inside, nothing is an escape, so without this a raw path such as """"C:\Users\"""" reads as ordinary quotes plus a trailing backslash escape, which swallows the rest of the file and leaves the enclosing method and class at their signature lines. */
  rawStringQuotes?: boolean
  /** Whether `r"(` (R's raw character constant, with optional dash padding as in `r"---(`) opens a literal that runs verbatim to its mirrored closer. R spells it this way per the base help page `?Quotes`, "Raw character constants"; no other language here does. Its content takes no escapes and may hold an unpaired quote, so without this the scan reads it as an ordinary quoted string, re-pairs the quotes inside it, and then counts a `}` sitting in the constant's text as a real closing brace -- ending the enclosing function at that line instead of at its body. */
  rRawStrings?: boolean
  /** Whether ''' opens a triple-quoted string on the same terms as {@link tripleQuote}. Dart has both spellings; Kotlin, Scala and Swift have only the double-quoted one, and there ''' is something else. Without this a Dart literal holding an odd number of single quotes, such as '''a ' } b''', re-pairs them so the brace between them is read as code and the enclosing method ends on it. */
  tripleSingleQuote?: boolean
  /** The language's string-interpolation syntax, so a `}` or quote inside a hole (`"${raw.replace("}", "")}"`) is read as code of the hole and never closes the outer string or counts as a brace. */
  interpolation?: InterpolationLang
  /** Which quotes of a closing run longer than three end a {@link tripleQuote}/{@link tripleSingleQuote} literal: see {@link QuoteRunClose} for each language's rule and its citation. Defaults to `'last'`, which is Kotlin's, Scala's and Swift's; Dart must pass `'first'`. */
  tripleQuoteRunClose?: QuoteRunClose
}

/** The triple-quote delimiters in play for a scan. A language may have one spelling, both, or neither. */
function tripleQuoteDelimiters(opts: BraceScanOpts | undefined): readonly string[] {
  const delims: string[] = []
  if (opts?.tripleQuote === true) delims.push('"""')
  if (opts?.tripleSingleQuote === true) delims.push("'''")
  return delims
}

/** How many consecutive quote characters start at `i`. */
function quoteRunLength(content: string, i: number): number {
  let n = 0
  while (content[i + n] === '"') n++
  return n
}

/** Index just past the first run of at least `min` quotes at or after `from`, or -1 if there is none. A C# raw string closes on a quote run at least as long as the one that opened it, so a shorter run inside the literal is content rather than the closer. */
function skipRawStringQuotes(content: string, from: number, min: number): number {
  return closingQuoteRunEnd(content, from, '"', min, 'last')
}

/** One step through a PowerShell string literal: inside a double-quoted string a backtick escapes the next character, and a backslash escapes nothing in either kind. Returns the index the caller should resume from and whether the string is still open. PowerShell's other escape, a doubled delimiter, needs no rule here: it adds two quotes, so it cannot change which side of a string a later brace falls on. */
function stepPowershellString(content: string, i: number, quote: string): { next: number; open: boolean } {
  const ch = content[i]
  if (quote === '"' && ch === '`') return { next: i + 1, open: true }
  return { next: i, open: ch !== quote }
}

/** True when the `"` at `i` opens a C# verbatim string, i.e. it is prefixed by `@`, `$@` or `@$`. */
function opensCsharpVerbatimString(content: string, i: number): boolean {
  const prev = content[i - 1]
  return prev === '@' || (prev === '$' && content[i - 2] === '@')
}

/** A language may have more than one line-comment prefix (PHP accepts both `//` and `#`), so both halves of the brace walk normalize to a list. */
function toLineCommentPrefixes(prefix: string | readonly string[] | undefined): readonly string[] {
  if (prefix === undefined) return []
  return typeof prefix === 'string' ? [prefix] : prefix
}

/** Whether a line comment starts at `i`. An exception literal wins over a prefix it starts with, so PHP's `#[` attribute is not read as a `#` comment. */
function atLineComment(content: string, i: number, prefixes: readonly string[], exceptions: readonly string[]): boolean {
  if (exceptions.some((e) => content.startsWith(e, i))) return false
  return prefixes.some((prefix) => content.startsWith(prefix, i))
}

/** Index just past the closer of the block comment opening at `start`, or -1 if it is never closed. With `nested` false this is a plain first-closer scan, byte-identical to the `indexOf` it replaces; with it true an inner opener increments a depth counter, so only the closer that balances the outermost opener ends the comment. */
function skipBlockComment(content: string, start: number, block: readonly [string, string], nested: boolean): number {
  let i = start + block[0].length
  let depth = 1
  while (i < content.length) {
    if (nested && content.startsWith(block[0], i)) { depth++; i += block[0].length; continue }
    if (content.startsWith(block[1], i)) {
      depth--
      i += block[1].length
      if (depth === 0) return i
      continue
    }
    i++
  }
  return -1
}

export function findMatchingBraceEndLine(
  content: string,
  openBraceIndex: number,
  totalLines: number,
  lineIndex: readonly number[],
  lineCommentPrefix?: string | readonly string[],
  opts?: BraceScanOpts,
): number {
  const linePrefixes = toLineCommentPrefixes(lineCommentPrefix)
  const lineExceptions = opts?.lineCommentExceptions ?? []
  const block = opts?.blockComment
  const backtick = opts?.backtickQuote === true
  const escapes = opts?.stringEscapes ?? 'backslash'
  const nestedBlock = opts?.nestedBlockComments === true
  const rawString = opts?.rawStringQuotes === true
  const rRaw = opts?.rRawStrings === true
  const tripleDelims = tripleQuoteDelimiters(opts)
  const lineString = opts?.lineStringPrefix
  const interpolation = opts?.interpolation
  let interpolated = false
  let depth = 0
  let quote: string | null = null
  // Set when `quote` was opened by a C# verbatim string: inside one, `\` is an ordinary character and a doubled `""` is the escaped quote.
  let verbatim = false
  for (let i = openBraceIndex; i < content.length; i++) {
    const ch = content[i]
    if (quote !== null) {
      if (interpolated && interpolation !== undefined) {
        const past = skipInterpolationAt(content, i, content.length, interpolation)
        if (past !== null) { i = past - 1; continue }
      }
      if (verbatim) {
        if (ch === quote) {
          if (content[i + 1] === quote) { i++; continue }
          quote = null
          verbatim = false
        }
        continue
      }
      if (escapes === 'powershell') {
        const step = stepPowershellString(content, i, quote)
        i = step.next
        if (!step.open) quote = null
        continue
      }
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    // Block comments before line comments: the two openers never overlap, but a `{`/`}` inside a block comment must be skipped before the brace-depth checks below ever see it.
    if (block !== undefined && content.startsWith(block[0], i)) {
      const end = skipBlockComment(content, i, block, nestedBlock)
      i = end === -1 ? content.length : end - 1
      continue
    }
    // Opt-in, because the callers that pass already-stripped content must not pay for a second pass, and a prefix that is not a comment marker in their language would corrupt the walk.
    if (atLineComment(content, i, linePrefixes, lineExceptions)) {
      while (i < content.length && content[i] !== '\n') i++
      continue
    }
    // A line-prefixed string literal (Zig's `\\`) runs to end of line and is opaque, so a `}` in its text is not a brace.
    if (lineString !== undefined && content.startsWith(lineString, i)) {
      while (i < content.length && content[i] !== '\n') i++
      continue
    }
    // An R raw character constant is opaque and its closer is decided by the opening punctuation, so jump past the whole thing before the quote rules below can re-pair the quotes inside it.
    if (rRaw) {
      const rOpen = matchRRawOpener(content, i)
      if (rOpen !== null) {
        const end = content.indexOf(rOpen.closer, rOpen.openerEnd)
        i = end === -1 ? content.length : end + rOpen.closer.length - 1
        continue
      }
    }
    // A C# raw string is opaque and its delimiter length varies, so measure the opening run and jump past the first run at least as long.
    if (rawString && ch === '"') {
      const run = quoteRunLength(content, i)
      if (run >= 3) {
        const end = skipRawStringQuotes(content, i + run, run)
        i = end === -1 ? content.length : end - 1
        continue
      }
    }
    // A triple-quoted literal is opaque: no escapes apply inside it, so jump straight past its closer rather than letting the single-quote rules below misread its contents.
    const tripleAt = tripleDelims.find((t) => content.startsWith(t, i))
    if (tripleAt !== undefined) {
      const end = closingQuoteRunEnd(content, i + 3, tripleAt[0] ?? '"', 3, opts?.tripleQuoteRunClose ?? 'last')
      i = end === -1 ? content.length : end - 1
      continue
    }
    if (ch === "'" && opts?.symbolLiterals === true) {
      const charLen = scalaCharLiteralLength(content, i)
      if (charLen > 0) i += charLen - 1
      continue
    }
    if (ch === '"' || ch === "'" || (backtick && ch === '`')) {
      quote = ch
      verbatim = escapes === 'csharp' && ch === '"' && opensCsharpVerbatimString(content, i)
      interpolated = interpolation !== undefined && opensInterpolatedString(content, i, interpolation)
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return offsetToLine(lineIndex, i)
      }
    }
  }
  return opts?.noMatchValue ?? totalLines
}

/** Give single-line symbols their real block span. The heuristic (non-tree-sitter) adapters -- C#, Kotlin, Swift, Scala, Dart, PHP, Zig, PowerShell, Bash -- all emit symbols through {@link makeLineSymbol}, which stores `lineEnd === lineStart` and a signature-only `body`. That is fine for genuinely one-line symbols (a `const`, an `env_key`) but wrong for anything with a brace block: `read "Foo.kt::greet"` then returns just `fun greet(): String` instead of the function, and callers that wanted the body have no option left but to read the whole file -- exactly the token burn these commands exist to avoid. Span-based languages (the tree-sitter extractors) never had this problem, so the same command was quietly worth far less on these nine languages. Only symbols still at `lineEnd === lineStart` are considered, so an adapter that already computed a real span keeps it. Two guards keep a declaration from swallowing the block that merely follows it (`const X = 5;` sitting above `function foo() {`): - the search for the opening brace stops before the next symbol's start line, so a brace belonging to a later sibling is never reachable, and - a `;` before the brace ends the search, because a statement terminator means the declaration closed and any later brace opens something else. The brace search still spans several lines, so a multi-line signature (parameters broken across lines, with the brace on the closing line) is matched. Nesting needs no special handling: {@link findMatchingBraceEndLine} walks the real brace depth, so a class span naturally encloses its methods and each method keeps its own narrower span. */
export function assignBraceBlockSpans(
  symbols: readonly SymbolEntry[],
  content: string,
  opts: BraceSpanOpts = {},
): SymbolEntry[] {
  const lineCommentPrefix = opts.lineComment
  const stringEscapes = opts.stringEscapes ?? 'backslash'
  const nestedBlockComments = opts.nestedBlockComments ?? false
  const tripleQuote = opts.tripleQuote ?? false
  const lineStringPrefix = opts.lineStringPrefix
  const firstLinePrefix = toLineCommentPrefixes(lineCommentPrefix)[0]
  if (symbols.length === 0) return [...symbols]
  const lines = content.split('\n')
  const totalLines = lines.length
  const lineIndex = buildLineIndex(content)
  // Sorted start lines let each symbol find the next one that begins strictly after it, which is the boundary the brace search must not cross. Built once rather than per symbol.
  const starts = [...new Set(symbols.map((s) => s.lineStart))].sort((a, b) => a - b)
  // Braces are walked over a copy with every multi-line-capable string literal blanked, so a brace or a quote inside one is text. The blanking is offset-preserving, so `lineIndex` and every offset below still address the same places, and bodies are still sliced from the untouched `lines`.
  const scanContent = opts.multilineLang === undefined ? content : maskMultilineStrings(content, opts.multilineLang)
  // Block-comment delimiters for the two comment styles these callers use, so a brace inside a `/* ... */` (C-style) or `<# ... #>` (PowerShell) comment never derails the brace search. An explicit `blockComment` overrides the guess, and `null` means the language has none at all: Zig writes `//` line comments but has no block comment, so deriving `/* */` from the prefix made an ordinary `a/*b` (divide then dereference) open a comment that never closed.
  const blockComment: readonly [string, string] | undefined =
    opts.blockComment !== undefined
      ? (opts.blockComment ?? undefined)
      : firstLinePrefix === '//' ? ['/*', '*/'] : firstLinePrefix === '#' ? ['<#', '#>'] : undefined
  const scanOpts: BraceScanOpts = {
    noMatchValue: -1,
    stringEscapes,
    tripleQuote,
    rawStringQuotes: opts.rawStringQuotes ?? false,
    tripleSingleQuote: opts.tripleSingleQuote ?? false,
    tripleQuoteRunClose: opts.tripleQuoteRunClose ?? 'last',
    ...(opts.interpolation === undefined ? {} : { interpolation: opts.interpolation }),
    ...(blockComment === undefined ? {} : { blockComment, nestedBlockComments }),
    ...(lineStringPrefix === undefined ? {} : { lineStringPrefix }),
    ...(opts.symbolLiterals === true ? { symbolLiterals: true } : {}),
    ...(opts.lineCommentExceptions === undefined ? {} : { lineCommentExceptions: opts.lineCommentExceptions }),
  }
  return symbols.map((sym) => {
    if (sym.lineEnd !== sym.lineStart) return sym
    const nextStart = starts.find((s) => s > sym.lineStart)
    if (opts.expressionBodies === true) {
      const arrowLast = Math.min(nextStart !== undefined ? nextStart - 1 : totalLines, sym.lineStart + BRACE_SEARCH_MAX_LINES)
      const arrowEnd = findArrowBodyEndLine(scanContent, lineIndex, sym.lineStart, arrowLast)
      if (arrowEnd !== null) {
        return arrowEnd <= sym.lineStart ? withWholeLineBody(sym, lines) : { ...sym, lineEnd: arrowEnd, body: lines.slice(sym.lineStart - 1, arrowEnd).join('\n') }
      }
    } else if (opts.expressionBodies === 'kotlin') {
      const eqEnd = findKotlinEqualsBodyEndLine(scanContent, lineIndex, sym.lineStart, nextStart !== undefined ? nextStart - 1 : totalLines)
      if (eqEnd !== null) {
        return eqEnd <= sym.lineStart ? withWholeLineBody(sym, lines) : { ...sym, lineEnd: eqEnd, body: lines.slice(sym.lineStart - 1, eqEnd).join('\n') }
      }
    }
    // Cap the window so the last symbol in a file cannot reach an unrelated brace far below it.
    const lastSearchLine = Math.min(nextStart !== undefined ? nextStart - 1 : totalLines, sym.lineStart + BRACE_SEARCH_MAX_LINES)
    const openIndex = findBlockOpenBrace(scanContent, lineIndex, sym.lineStart, lastSearchLine, lineCommentPrefix, TYPE_HEADER_KINDS.test(sym.kind) ? { ...scanOpts, typeHeader: true } : scanOpts)
    if (openIndex === null) return sym
    if (opts.expressionBodies === 'kotlin' && isAbstractValueFollowedByBareBlock(sym, scanContent, lineIndex, openIndex)) return sym
    // noMatchValue -1: an unbalanced/unclosed brace must not stretch the symbol to end-of-file.
    const endLine = findMatchingBraceEndLine(scanContent, openIndex, totalLines, lineIndex, lineCommentPrefix,
      scanOpts)
    // A block closing on the signature line keeps that whole line; -1 (no match) leaves the symbol as it was.
    if (endLine === sym.lineStart) return withWholeLineBody(sym, lines)
    if (endLine < sym.lineStart) return sym
    return { ...sym, lineEnd: endLine, body: lines.slice(sym.lineStart - 1, endLine).join('\n') }
  })
}

/** The symbol with its whole source line as the body when its stored text stops short of the block it opened. The regex adapters cut the signature at the first `{` (the PHP one at the first `)`), which is right while the block spans later lines and replaces it, but drops `return a + b;` from `int Add(int a, int b) { return a + b; }`. A body that already holds a brace is whole-line text (Swift, Scala) and is left alone. */
function withWholeLineBody(sym: SymbolEntry, lines: readonly string[]): SymbolEntry {
  const line = lines[sym.lineStart - 1]
  if (line === undefined || sym.body.includes('{') || !line.includes('{')) return sym
  return { ...sym, body: line.trimEnd() }
}

/** How far past a symbol's start line {@link assignBraceBlockSpans} will look for the brace that opens its body. Generous enough for a signature whose parameters are broken across lines, while still bounding the damage when a symbol genuinely has no block and no later sibling caps the search. */
const BRACE_SEARCH_MAX_LINES = 10

/** Index just past the `{ ... }` hole that opens at `i` inside a C# interpolated string, skipping any literal nested in it. */
function skipCsharpInterpolationHole(content: string, i: number, to: number): number {
  let depth = 0
  for (let k = i; k < to; k++) {
    const lit = skipCsharpLiteral(content, k, to)
    if (lit !== null) { k = lit - 1; continue }
    const ch = content[k]
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return k + 1
  }
  return to
}

/** Index just past the C# string or char literal that starts at `i` (a plain, verbatim, interpolated, raw, or char literal), or null when `i` does not start one. Interpolation holes are walked as code, so a quote or brace inside one does not end the literal early. */
function skipCsharpLiteral(content: string, i: number, to: number): number | null {
  const first = content[i]
  if (first === "'") {
    if (content[i + 1] === '\\') {
      const close = content.indexOf("'", i + 3)
      return close === -1 || close >= to ? null : close + 1
    }
    return content[i + 2] === "'" ? i + 3 : null
  }
  let j = i
  while ((content[j] === '$' || content[j] === '@') && j - i < 3) j++
  if (content[j] !== '"') return null
  const prefix = content.slice(i, j)
  if (j > i && /[A-Za-z0-9_]/.test(content[i - 1] ?? '')) return null
  const interpolated = prefix.includes('$')
  const verbatim = prefix.includes('@')
  const run = quoteRunLength(content, j)
  if (run >= 3) {
    const end = skipRawStringQuotes(content, j + run, run)
    return end === -1 ? to : end
  }
  for (let k = j + 1; k < to; k++) {
    const ch = content[k]
    if (ch === undefined) break
    if (verbatim) {
      if (ch === '"') {
        if (content[k + 1] === '"') { k++; continue }
        return k + 1
      }
    } else if (ch === '\\') { k++; continue }
    else if (ch === '"') return k + 1
    if (interpolated) {
      if (ch === '{') {
        if (content[k + 1] === '{') { k++; continue }
        k = skipCsharpInterpolationHole(content, k, to) - 1
      }
    }
  }
  return to
}

/** Last line of a C# expression-bodied member (`Name(args) => expr;`, `Prop => expr;`) that starts on `startLine`, or null when the declaration has no `=>` body: a `{` or `;` reached at bracket depth 0 before any `=>` means a block body or a bodiless declaration, and the brace walk owns those. The body ends at the first `;` at depth 0, so a multi-line `a &&\n b;` is spanned whole. Strings, chars, comments, verbatim, interpolated and raw strings are skipped, so a `;` or `=>` inside one is text. */
function findArrowBodyEndLine(content: string, lineIndex: readonly number[], startLine: number, lastSearchLine: number): number | null {
  const from = lineIndex[startLine - 1]
  if (from === undefined) return null
  const to = lineIndex[lastSearchLine] ?? content.length
  let depth = 0
  let seenArrow = false
  for (let i = from; i < to; i++) {
    const ch = content[i]
    if (ch === undefined) break
    if (ch === '/' && content[i + 1] === '/') {
      while (i + 1 < to && content[i + 1] !== '\n') i++
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      if (end === -1) return null
      i = end + 1
      continue
    }
    const lit = skipCsharpLiteral(content, i, to)
    if (lit !== null) { i = lit - 1; continue }
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') { if (depth > 0) depth-- }
    else if (ch === '=' && content[i + 1] === '>' && depth === 0) { seenArrow = true; i++ }
    else if (ch === '{') {
      if (!seenArrow && depth === 0) return null
      depth++
    } else if (ch === '}') {
      if (depth === 0) return null
      depth--
    } else if (ch === ';' && depth === 0) {
      if (!seenArrow) return null
      // The terminator's own line, found by counting the newlines between the start and it.
      let line = startLine
      for (let k = from; k < i; k++) if (content[k] === '\n') line++
      return line
    }
  }
  return null
}

/** Index just past the `${ ... }` hole that opens at `i` inside a Kotlin string template, skipping any literal nested in it. */
function skipKotlinTemplateHole(content: string, i: number, to: number): number {
  let depth = 0
  for (let k = i; k < to; k++) {
    const lit = skipKotlinLiteral(content, k, to)
    if (lit !== null) { k = lit - 1; continue }
    const ch = content[k]
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return k + 1
  }
  return to
}

/** Index just past the Kotlin string or char literal that starts at `i`, or null when `i` does not start one. Template holes are walked as code, so a quote inside one does not end the string early. */
function skipKotlinLiteral(content: string, i: number, to: number): number | null {
  const first = content[i]
  if (first === "'") {
    for (let k = i + 1; k < to && content[k] !== '\n'; k++) {
      if (content[k] === '\\') { k++; continue }
      if (content[k] === "'") return k + 1
    }
    return null
  }
  if (first !== '"') return null
  const triple = content.startsWith('"""', i)
  for (let k = i + (triple ? 3 : 1); k < to; k++) {
    const ch = content[k]
    if (triple) {
      if (ch === '"' && content.startsWith('"""', k)) {
        k += 3
        while (content[k] === '"') k++
        return k
      }
    } else if (ch === '\\') { k++; continue }
    else if (ch === '"') return k + 1
    else if (ch === '\n') return k
    if (ch === '$' && content[k + 1] === '{') k = skipKotlinTemplateHole(content, k + 1, to) - 1
  }
  return to
}

/** The languages whose strings interpolate code, each with its own hole syntax: Kotlin, Dart and Scala `${ ... }`, C# `{ ... }` inside `$"..."`, Swift `\( ... )`. */
export type InterpolationLang = 'kotlin' | 'dart' | 'scala' | 'csharp' | 'swift'

/** Whether the quote at `i` opens a string that interpolates: C# only after a `$`, Scala only after an interpolator prefix (`s"`, `f"`, `raw"`), Dart not for a raw `r"..."` string, and Swift/Kotlin always for a double-quoted one. */
function opensInterpolatedString(content: string, i: number, lang: InterpolationLang): boolean {
  const q = content[i]
  const prev = content[i - 1] ?? ''
  if (lang === 'csharp') return q === '"' && (prev === '$' || (prev === '@' && content[i - 2] === '$'))
  if (lang === 'scala') return q === '"' && /[A-Za-z0-9_]/.test(prev)
  if (lang === 'dart') return !(prev === 'r' && !/[A-Za-z0-9_$]/.test(content[i - 2] ?? ''))
  return q === '"'
}

/** Index just past the interpolation hole that opens at `i` inside an interpolated string (or past a C# `{{` escape), or null when `i` opens none. */
function skipInterpolationAt(content: string, i: number, to: number, lang: InterpolationLang): number | null {
  const ch = content[i]
  if (lang === 'swift') return ch === '\\' && content[i + 1] === '(' ? skipInterpolationHole(content, i + 1, to, lang) : null
  if (lang === 'csharp') {
    if (ch !== '{') return null
    return content[i + 1] === '{' ? i + 2 : skipInterpolationHole(content, i, to, lang)
  }
  return ch === '$' && content[i + 1] === '{' ? skipInterpolationHole(content, i + 1, to, lang) : null
}

/** Index just past the hole whose opening `{` or `(` is at `i`, skipping every literal nested in it. A Swift hole counts parentheses and the others count braces, so a code brace inside a Swift hole is irrelevant and a closure brace inside a Kotlin hole does not end it. */
function skipInterpolationHole(content: string, i: number, to: number, lang: InterpolationLang): number {
  const open = content[i]
  const close = open === '(' ? ')' : '}'
  let depth = 0
  for (let k = i; k < to; k++) {
    const lit = skipNestedLiteral(content, k, to, lang)
    if (lit !== null) { k = lit - 1; continue }
    const ch = content[k]
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return k + 1
  }
  return to
}

/** Index just past the string or character literal that starts at `i` inside a hole, or null when `i` starts none. */
function skipNestedLiteral(content: string, i: number, to: number, lang: InterpolationLang): number | null {
  const ch = content[i]
  if (lang === 'csharp') return skipCsharpLiteral(content, i, to)
  if (lang === 'kotlin') return skipKotlinLiteral(content, i, to)
  if (ch === "'" && lang === 'scala') {
    const len = scalaCharLiteralLength(content, i)
    return len > 0 ? i + len : null
  }
  if (ch !== '"' && !(ch === "'" && lang === 'dart')) return null
  return skipInterpolatedString(content, i, to, lang, opensInterpolatedString(content, i, lang))
}

/** Index just past the single-line Swift/Dart/Scala string that opens at `i`, skipping any hole it carries; a string never runs past a newline, so an unterminated one stops there. A triple-quoted literal runs verbatim to its closer. */
function skipInterpolatedString(content: string, i: number, to: number, lang: InterpolationLang, interpolated: boolean): number {
  const q = content[i] as string
  if (content.startsWith(q + q + q, i)) {
    const end = content.indexOf(q + q + q, i + 3)
    return end === -1 || end >= to ? to : end + 3
  }
  for (let k = i + 1; k < to; k++) {
    const ch = content[k]
    if (ch === '\n') return k
    if (interpolated) {
      const past = skipInterpolationAt(content, k, to, lang)
      if (past !== null) { k = past - 1; continue }
    }
    if (ch === '\\') { k++; continue }
    if (ch === q) return k + 1
  }
  return to
}

/** Whether a Kotlin expression body whose line ends at `lastSig` carries on to the next line: it ends in an operator, `else`, or the `)` of an `if (...)` header, or the next code line opens with a token that can only continue an expression (`.foo`, `?.`, `?:`, `&&`, `||`, `else`, `as`, `catch`, `finally`). A leading `+` or `-` does not count, since Kotlin starts a new statement there. */
function kotlinBodyContinues(content: string, lastSig: number, ifParenClosedAt: number, nextLineFrom: number): boolean {
  const c = content[lastSig]
  const prev = content[lastSig - 1]
  if (lastSig === ifParenClosedAt) return true
  if (c !== undefined && '=*/%&|,.:'.includes(c)) return true
  if ((c === '+' || c === '-') && prev !== c) return true
  if (c === '>' && prev === '-') return true
  if (/(?:^|[^A-Za-z0-9_])else$/.test(content.slice(Math.max(0, lastSig - 4), lastSig + 1))) return true
  const rest = content.slice(nextLineFrom)
  const next = /^(?:[ \t\r]*(?:\/\/[^\n]*)?\n)*[ \t]*(\.|\?\.|\?:|&&|\|\||else\b|as\b|catch\b|finally\b)/.exec(rest)
  return next !== null
}

/** The next code line (blank and `//` lines skipped) opens with `=`: an expression body whose `=` sits on its own continuation line, as in `fun f(): Int` then `    = init(3)`. */
const NEXT_LINE_STARTS_WITH_EQUALS = /^(?:[ \t\r]*(?:\/\/[^\n]*)?\n)*[ \t]*=(?!=)/

/** Last line of a Kotlin expression-bodied declaration (`fun f(x: Int) = expr`) that starts on `startLine`, or null when there is none: a `{` before the `=` is a block body, and a line that ends with no `=` and no open bracket is a bodiless declaration, for the brace walk or nothing to own. The `=` must sit at bracket depth 0, so a default argument (`fun f(x: Int = 0)`) is not one. Kotlin has no terminator, so the body ends at the first line break at depth 0 that the expression cannot cross: see {@link kotlinBodyContinues}. */
function findKotlinEqualsBodyEndLine(content: string, lineIndex: readonly number[], startLine: number, lastLine: number): number | null {
  const from = lineIndex[startLine - 1]
  if (from === undefined) return null
  const to = lineIndex[lastLine] ?? content.length
  let depth = 0
  let seenEq = false
  let line = startLine
  let lastSig = -1
  let ifParenClosedAt = -1
  const ifParens: boolean[] = []
  for (let i = from; i < to; i++) {
    const ch = content[i]
    if (ch === undefined) break
    if (ch === '\n') {
      if (depth === 0) {
        if (!seenEq && !NEXT_LINE_STARTS_WITH_EQUALS.test(content.slice(i + 1, to))) return null
        if (seenEq && !kotlinBodyContinues(content, lastSig, ifParenClosedAt, i + 1)) return line
      }
      line++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') continue
    if (ch === '/' && content[i + 1] === '/') {
      while (i + 1 < to && content[i + 1] !== '\n') i++
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      if (end === -1) return null
      for (let k = i; k < end; k++) if (content[k] === '\n') line++
      i = end + 1
      continue
    }
    const lit = skipKotlinLiteral(content, i, to)
    if (lit !== null) {
      for (let k = i; k < lit; k++) if (content[k] === '\n') line++
      lastSig = lit - 1
      i = lit - 1
      continue
    }
    lastSig = i
    if (ch === '(' || ch === '[' || ch === '{') {
      if (ch === '{' && !seenEq && depth === 0) return null
      ifParens.push(ch === '(' && /\bif\s*$/.test(content.slice(Math.max(from, i - 8), i)))
      depth++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return null
      depth--
      if (ifParens.pop() === true) ifParenClosedAt = i
    } else if (ch === '=' && !seenEq && depth === 0 && !'=!<>'.includes(content[i - 1] ?? ' ') && content[i + 1] !== '=') {
      seenEq = true
    }
  }
  return seenEq && depth === 0 ? line : null
}

/** Blank every multi-line-capable string literal in `content` for `lang`, carrying open state across line breaks exactly as {@link stripMultilineStringSpan} does per line. Offset-preserving: each literal's text is replaced by the same number of spaces and every line terminator is copied through, so a line index built from `content` still addresses the result. Line comments are left intact, because a brace walk over the result still needs to recognise them and each caller already knows its own comment markers. */
export function maskMultilineStrings(content: string, lang: MultilineStringLang): string {
  let state: MultilineStringState | null = null
  const parts: string[] = []
  let pos = 0
  for (;;) {
    const nl = content.indexOf('\n', pos)
    const end = nl === -1 ? content.length : nl
    const lineEnd = end > pos && content[end - 1] === '\r' ? end - 1 : end
    const masked = stripMultilineStringSpan(content.slice(pos, lineEnd), state, lang)
    state = masked.state
    parts.push(masked.code, content.slice(lineEnd, end))
    if (nl === -1) break
    parts.push('\n')
    pos = nl + 1
  }
  return parts.join('')
}

/** Offset of the brace that opens `startLine`'s block, or null when there is none to find within `lastSearchLine`. Skips braces inside quoted strings and line comments for the same reason {@link findMatchingBraceEndLine} does, and stops at a `;` because a closed statement cannot be the thing the following brace belongs to. */
function findBlockOpenBrace(
  content: string,
  lineIndex: readonly number[],
  startLine: number,
  lastSearchLine: number,
  lineCommentPrefix?: string | readonly string[],
  opts?: BraceScanOpts,
): number | null {
  const blockComment = opts?.blockComment
  const stringEscapes = opts?.stringEscapes ?? 'backslash'
  const nestedBlockComments = opts?.nestedBlockComments === true
  const rawString = opts?.rawStringQuotes === true
  const tripleDelims = tripleQuoteDelimiters(opts)
  const lineString = opts?.lineStringPrefix
  const linePrefixes = toLineCommentPrefixes(lineCommentPrefix)
  const lineExceptions = opts?.lineCommentExceptions ?? []
  const from = lineIndex[startLine - 1]
  if (from === undefined) return null
  // One past the last searchable line, so the scan covers lastSearchLine in full.
  const to = lineIndex[lastSearchLine] ?? content.length
  const interpolation = opts?.interpolation
  let interpolated = false
  let quote: string | null = null
  // Round/square-bracket depth, so a keyword inside a multi-line parameter list or call is not mistaken for the start of a new statement (see the keyword stop below).
  let parenDepth = 0
  // Lines consumed past `startLine`, and whether we are at the first non-space char of a line.
  let linesSeen = 0
  let atLineStart = false
  // Mirrors findMatchingBraceEndLine's verbatim tracking, so the two halves of the span walk agree on where a C# verbatim string ends.
  let verbatim = false
  for (let i = from; i < to; i++) {
    const ch = content[i]
    if (ch === undefined) break
    if (quote !== null) {
      // Mirrors findMatchingBraceEndLine's hole skip, so both halves of the span walk agree on where an interpolated string ends.
      if (interpolated && interpolation !== undefined) {
        const past = skipInterpolationAt(content, i, to, interpolation)
        if (past !== null) { i = past - 1; continue }
      }
      if (verbatim) {
        if (ch === quote) {
          if (content[i + 1] === quote) { i++; continue }
          quote = null
          verbatim = false
        }
        continue
      }
      if (stringEscapes === 'powershell') {
        const step = stepPowershellString(content, i, quote)
        i = step.next
        if (!step.open) quote = null
        continue
      }
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '\n') { linesSeen++; atLineStart = true; continue }
    if (blockComment !== undefined && content.startsWith(blockComment[0], i)) {
      const end = skipBlockComment(content, i, blockComment, nestedBlockComments)
      if (end === -1) return null
      i = end - 1
      continue
    }
    if (atLineComment(content, i, linePrefixes, lineExceptions)) {
      // Advance to just before the newline so the loop's own `\n` handling still runs for it.
      while (i + 1 < to && content[i + 1] !== '\n') i++
      continue
    }
    if (atLineStart && !/\s/.test(ch)) {
      atLineStart = false
      // A continuation line (one past the declaration) that begins with a block-opening control keyword, at bracket depth 0, means the declaration already ended and the next brace opens that statement -- not this symbol's body. Stop so a `val x = 10` above a bare `if (...) {}` does not swallow the if-block (semicolon-optional languages have no `;` to mark the end).
      if (parenDepth === 0 && linesSeen >= 1 && startsWithBlockKeyword(content, i, to, opts?.typeHeader !== true)) return null
    }
    // Mirrors findMatchingBraceEndLine's line-string skip, so both halves of the span walk agree that a Zig `\\` line is text rather than code.
    if (lineString !== undefined && content.startsWith(lineString, i)) {
      while (i + 1 < to && content[i + 1] !== '\n') i++
      continue
    }
    // Mirrors findMatchingBraceEndLine's raw-string skip, so both halves of the span walk agree on where a C# raw string ends.
    if (rawString && ch === '"') {
      const run = quoteRunLength(content, i)
      if (run >= 3) {
        const end = skipRawStringQuotes(content, i + run, run)
        if (end === -1) return null
        i = end - 1
        continue
      }
    }
    // Mirrors findMatchingBraceEndLine's triple-quote skip, so both halves of the span walk agree on where a `"""` literal ends.
    const tripleAt = tripleDelims.find((t) => content.startsWith(t, i))
    if (tripleAt !== undefined) {
      const end = closingQuoteRunEnd(content, i + 3, tripleAt[0] ?? '"', 3, opts?.tripleQuoteRunClose ?? 'last')
      if (end === -1) return null
      i = end - 1
      continue
    }
    if (ch === "'" && opts?.symbolLiterals === true) {
      const charLen = scalaCharLiteralLength(content, i)
      if (charLen > 0) i += charLen - 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      verbatim = stringEscapes === 'csharp' && ch === '"' && opensCsharpVerbatimString(content, i)
      interpolated = interpolation !== undefined && opensInterpolatedString(content, i, interpolation)
      continue
    }
    if (ch === '(' || ch === '[') parenDepth++
    else if (ch === ')' || ch === ']') { if (parenDepth > 0) parenDepth-- }
    else if (ch === ';') return null
    // A `}` reached before any `{`, outside brackets, closes an enclosing block, so this declaration has no body of its own and every later brace belongs to something else. Without this stop a brace-less member such as Scala's `val timeout = 30` at the end of an object body latched onto the next unindexed brace construct below the object and recorded a span running past its own parent.
    else if (ch === '}' && parenDepth === 0) return null
    else if (ch === '{') return i
  }
  return null
}

/** Control-flow keywords that open their own `{ ... }` block. A declaration followed by one of these has ended; the brace after belongs to the statement, not the declaration. */
const BLOCK_OPENING_KEYWORDS = new Set([
  'if', 'for', 'while', 'do', 'switch', 'when', 'match', 'try', 'foreach', 'loop', 'guard', 'repeat', 'unless', 'until',
])

/** An abstract `val`/`var` (no `=` on its line) never owns a block, so a `{` that starts a later line is the next statement, not its body. */
function isAbstractValueFollowedByBareBlock(sym: SymbolEntry, content: string, lineIndex: readonly number[], openIndex: number): boolean {
  const openLine = offsetToLine(lineIndex, openIndex)
  return /^va[lr]$/.test(sym.kind) && openLine > sym.lineStart && lineTextAt(content, lineIndex, openLine) === '{' && !lineTextAt(content, lineIndex, sym.lineStart).includes('=')
}

/** Symbol kinds whose header may continue on a line that starts with a member-start word. */
const TYPE_HEADER_KINDS = /^(?:class|object|interface|trait|enum|struct|protocol|record|extension)$/

/** Words that start the next member when they open a continuation line: `init {`, `locally {`, `constructor(`, `companion object`. Matched as whole words; no input reaches a shape check beyond the word (a mutation to a bare prefix and to each shape alternative left every test green). */
const MEMBER_START_WORDS = new Set(['init', 'locally', 'constructor', 'companion'])

/** True if the identifier starting at `i` (bounded by `to`) is exactly a {@link BLOCK_OPENING_KEYWORDS} entry, or (when `members`) a {@link MEMBER_START_WORDS} entry. Consumes a full `[A-Za-z0-9_]` run so `if2`/`iffy` never match the keyword `if`. */
function startsWithBlockKeyword(content: string, i: number, to: number, members: boolean): boolean {
  const first = content[i]
  if (first === undefined || !/[A-Za-z_]/.test(first)) return false
  let j = i + 1
  while (j < to && /[A-Za-z0-9_]/.test(content[j]!)) j++
  const word = content.slice(i, j)
  return BLOCK_OPENING_KEYWORDS.has(word) || (members && MEMBER_START_WORDS.has(word))
}


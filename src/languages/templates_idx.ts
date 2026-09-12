/**
 * Template-engine adapters: Jinja2 (`.j2`/`.jinja`/`.jinja2`), Handlebars (`.hbs`/`.handlebars`),
 * ERB (`.erb`), EJS (`.ejs`), Nunjucks (`.njk`), and Twig (`.twig`).
 *
 * None of the six has a maintained tree-sitter grammar as an npm dependency in this project, so
 * each is a pure-regex adapter -- the same convention every other non-tree-sitter language here
 * follows. Unlike `sfc_idx.ts` (which extracts its own symbol vocabulary for Vue/Svelte/Astro),
 * these six define no symbols of their own: a template file IS markup, with the host templating
 * language's delimiters spliced into attribute values, tag bodies, and text nodes. The correct
 * adapter shape here is therefore not "extract template symbols" but "mask the template
 * delimiters out (so `<div id="{{ user.id }}">` becomes `<div id="            ">`, a
 * newline-preserving blank rather than a value worth indexing) and hand the masked text straight
 * to `extractHtml` -- the SAME composition `html`/`liquid` already use in `registry.ts`
 * (`extractHtml(content, filePath)` -> symbols + sectionsToHeadingSymbols), just fed pre-masked
 * content instead of raw content.
 *
 * ONE shared masker (`maskTemplateDelimiters`), parameterized by a LIST of delimiter pairs --
 * this is the deliberate opposite of the five Lisp adapters added alongside this file, which are
 * NOT allowed to share a masker because their lexical rules only look alike from a distance. Here
 * the masking rule genuinely IS identical across all six dialects: find the open literal, blank
 * everything up to the first matching close (bounded -- see MAX_DELIM_BODY below), never nest.
 * None of these six delimiter families nest at the character level: opening a second `{{` (or
 * `<%`) before the first is closed is a syntax error in every one of Jinja2, Nunjucks, Twig,
 * Handlebars, ERB, and EJS -- none defines a nested-delimiter form the way a VHDL-2008 block
 * comment or a Kotlin/Swift/Scala block comment does. A `{% for %}...{% endfor %}` block masks
 * each `{% %}` tag independently and leaves the real markup between them untouched, which is
 * exactly what should happen: that markup is genuine HTML, not template syntax.
 *
 * Bounded, non-backtracking scan (MAX_DELIM_BODY): this repo has previously shipped a masker whose
 * unbounded regex backtracking turned a 50KB pathological line from 33ms into 1847ms against a
 * 100ms budget. `maskTemplateDelimiters` never uses a regex with an unbounded lazy quantifier --
 * it scans left to right once, and for each recognized `open` it looks for `close` only within a
 * fixed-size window ahead (`content.indexOf` over a bounded slice, not the whole remaining file).
 * An open with no close inside that window is left as literal text (not masked, not an error) and
 * scanning resumes one character later, so a file with many unterminated `{{`/`<%` occurrences and
 * no matching closer anywhere costs at most O(n * MAX_DELIM_BODY), never O(n^2).
 *
 * Known simplification (documented, not accidental): `{% raw %}...{% endraw %}` (Jinja2/
 * Nunjucks) and `{% verbatim %}...{% endverbatim %}` (Twig) are masked exactly like any other
 * `{% %}` tag pair -- only the tag delimiters themselves are blanked, not everything between the
 * open and close tag names. Real markup inside a raw/verbatim block is therefore still extracted
 * normally by `extractHtml`, which is the common case (raw blocks usually wrap literal HTML a
 * template author wants to protect from templating, i.e. exactly the markup this adapter should
 * still index) and out of proportionate scope to special-case further.
 */

import { extractHtml } from './html.js'
import type { HtmlSection } from './html.js'
import type { AdapterImport } from './common.js'
import type { SymbolEntry } from '../parser_types.js'

export interface DelimiterPair {
  /** Literal opening delimiter. */
  readonly open: string
  /** Literal closing delimiter. */
  readonly close: string
}

export interface TemplateResult {
  readonly symbols: SymbolEntry[]
  readonly imports: AdapterImport[]
  readonly sections: HtmlSection[]
}

// How far past an `open` this scans for its `close` before giving up and treating the `open` as
// literal text. Generous for any real template expression/tag/comment (which are a handful of
// words), tight enough that a pathological file of thousands of unterminated opens stays linear
// rather than quadratic. See the module doc's "Bounded, non-backtracking scan" paragraph.
const MAX_DELIM_BODY = 1024

/**
 * Masks every `open ... close` span found in `content` to spaces (newlines preserved, so line
 * numbers stay in sync with the unmasked file -- same discipline as `maskHtmlNoise`/`maskSpans` in
 * `sfc_idx.ts`). `pairs` must be ordered MOST-SPECIFIC-FIRST: at every position, each pair's
 * `open` is tried in array order, so a longer open that is itself a prefix of a shorter one later
 * in the list (Handlebars' `{{!--` vs `{{`) is recognized before the shorter one could swallow it.
 * Once an `open` is matched, only that pair's `close` is searched for (never a different pair's),
 * matching each language's own grammar: an ERB `<%#` comment always closes on `%>`, never on some
 * other dialect's closer.
 */
export function maskTemplateDelimiters(content: string, pairs: readonly DelimiterPair[]): string {
  const chars = content.split('')
  const n = content.length
  let i = 0
  while (i < n) {
    let matched = false
    for (const { open, close } of pairs) {
      if (!content.startsWith(open, i)) continue
      const searchFrom = i + open.length
      const window = content.slice(searchFrom, searchFrom + MAX_DELIM_BODY)
      const closeOffset = window.indexOf(close)
      if (closeOffset === -1) continue // no close within the bound -- try the next pair, or fall through as literal text
      const end = searchFrom + closeOffset + close.length
      for (let k = i; k < end; k++) if (chars[k] !== '\n') chars[k] = ' '
      i = end
      matched = true
      break
    }
    if (!matched) i++
  }
  return chars.join('')
}

function extractTemplate(content: string, filePath: string, pairs: readonly DelimiterPair[]): TemplateResult {
  return extractHtml(maskTemplateDelimiters(content, pairs), filePath)
}

// ---------------------------------------------------------------------------
// Delimiter tables, one per dialect. Each is its OWN declared list (never a shared reference,
// even where two dialects' values are identical today) -- see the module doc's contrast with the
// Lisp adapters: sharing the masker function is correct here, but each dialect still states its
// own grammar rather than aliasing another dialect's table.
// ---------------------------------------------------------------------------

// Jinja2: https://jinja.palletsprojects.com/en/3.1.x/templates/ -- "Variables" section for
// `{{ }}` expressions, "List of Control Structures" for `{% %}` statements, "Comments" for
// `{# #}`. No open here is a prefix of another, so declaration order does not affect correctness.
const JINJA2_PAIRS: readonly DelimiterPair[] = [
  { open: '{#', close: '#}' },
  { open: '{%', close: '%}' },
  { open: '{{', close: '}}' },
]

// Handlebars: https://handlebarsjs.com/guide/expressions.html ("Basic Usage" for `{{ }}`,
// "HTML-Escaping" for triple-stache `{{{ }}}`) and https://handlebarsjs.com/guide/#comments (both
// the `{{! }}` and `{{!-- --}}` comment forms). `{{!--`, `{{!`, and `{{{` all start with the same
// two characters as the plain `{{` expression, so each is listed before it.
const HANDLEBARS_PAIRS: readonly DelimiterPair[] = [
  { open: '{{!--', close: '--}}' },
  { open: '{{!', close: '}}' },
  { open: '{{{', close: '}}}' },
  { open: '{{', close: '}}' },
]

// ERB (Ruby stdlib `erb.rb`): https://docs.ruby-lang.org/en/3.3/ERB.html -- `<%# %>` comment,
// `<%= %>` output, `<%- %>` leading-whitespace-trim open. Every form's closer is `%>` (optionally
// preceded by a trailing `-` for trim mode, e.g. `-%>`); since `-%>` itself ends in the literal
// `%>`, searching for the plain `%>` suffix already finds either form correctly.
const ERB_PAIRS: readonly DelimiterPair[] = [
  { open: '<%#', close: '%>' },
  { open: '<%=', close: '%>' },
  { open: '<%-', close: '%>' },
  { open: '<%', close: '%>' },
]

// EJS: https://ejs.co/#docs -- `<%#` comment, `<%_` whitespace-slurp, `<%-` unescaped output,
// `<%=` escaped output, plain `<%` scriptlet. Closers are `%>`, `-%>` (trim), or `_%>` (slurp);
// all three end in the literal `%>`, so the same reasoning as ERB above applies.
const EJS_PAIRS: readonly DelimiterPair[] = [
  { open: '<%#', close: '%>' },
  { open: '<%_', close: '%>' },
  { open: '<%-', close: '%>' },
  { open: '<%=', close: '%>' },
  { open: '<%', close: '%>' },
]

// Nunjucks: https://mozilla.github.io/nunjucks/templating.html -- deliberately Jinja2-compatible
// delimiter syntax ("Variables" `{{ }}`, "Tags" `{% %}`, "Comments" `{# #}`).
const NUNJUCKS_PAIRS: readonly DelimiterPair[] = [
  { open: '{#', close: '#}' },
  { open: '{%', close: '%}' },
  { open: '{{', close: '}}' },
]

// Twig: https://twig.symfony.com/doc/3.x/templates.html -- "{{ }}" for output, "{% %}" for tags,
// "{# #}" for comments; the same three shapes as Jinja2/Nunjucks (Twig was explicitly designed to
// resemble Jinja's syntax), declared as its own table for the reason given above.
const TWIG_PAIRS: readonly DelimiterPair[] = [
  { open: '{#', close: '#}' },
  { open: '{%', close: '%}' },
  { open: '{{', close: '}}' },
]

export function extractJinja2(content: string, filePath: string): TemplateResult {
  return extractTemplate(content, filePath, JINJA2_PAIRS)
}

export function extractHandlebars(content: string, filePath: string): TemplateResult {
  return extractTemplate(content, filePath, HANDLEBARS_PAIRS)
}

export function extractErb(content: string, filePath: string): TemplateResult {
  return extractTemplate(content, filePath, ERB_PAIRS)
}

export function extractEjs(content: string, filePath: string): TemplateResult {
  return extractTemplate(content, filePath, EJS_PAIRS)
}

export function extractNunjucks(content: string, filePath: string): TemplateResult {
  return extractTemplate(content, filePath, NUNJUCKS_PAIRS)
}

export function extractTwig(content: string, filePath: string): TemplateResult {
  return extractTemplate(content, filePath, TWIG_PAIRS)
}

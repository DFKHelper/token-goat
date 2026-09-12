/**
 * The escaping half of the two-neutralizer rule, enforced by shape rather than by a list of files.
 *
 * token-goat has two neutralizers and they are not interchangeable. `fenceUntrusted*` wraps a
 * PAYLOAD -- a block of third-party bytes -- in tags, and neutralizes token-goat's markers inside
 * it. `displaySafeText` protects a line token-goat speaks in its OWN voice: it escapes the
 * `[token-goat` and `[tg]` marker spellings plus C0/C1, U+2028/9 and the format characters. A sink
 * is vulnerable when text the project chose -- a symbol name, a lockfile key, a TODO line, a
 * config value, a branch label -- lands in a token-goat-voice line that is neither fenced nor
 * escaped.
 *
 * Why a CLI report is not merely cosmetic terminal output: `mcp_server.ts`'s `captureOutput` ->
 * `toCallToolResult` turns every one of these reports into a model-facing MCP tool result, and
 * `mcpFriendlyText` neutralizes nothing on the way. `postBashHandler` passes short CLI output
 * straight through to the model as well. So an unescaped `[tg] ` in a package name is not a
 * cosmetic glitch in a terminal; it is a line arriving at the model wearing token-goat's authority.
 *
 * WHY THIS SCANS INSTEAD OF LISTING. The obvious version of this guard enumerates the modules
 * known to be bad today and checks each one. That version goes green the moment somebody adds a
 * fourteenth module, which is precisely when it needed to speak. This repo has already shipped the
 * failure where a guard's population emptied or aged out silently and it went on passing. So the
 * population here is "every `.ts` under src/", derived at run time, and the check is on the SHAPE:
 * an untrusted-source accessor interpolated into a sink without a neutralizer in the same
 * expression. A module that does not exist in the working tree today is covered the day it lands.
 *
 * ON `emitGuarded`. It appears below as a SINK, never as a neutralizer. `emitGuarded` is a
 * token-budget truncator (`guardText` -> `trimToBudget`): it shortens output so it fits a ceiling.
 * It performs no escaping and no fencing whatsoever. Routing hostile text through it changes how
 * much of that text arrives, not whether it arrives wearing token-goat's voice -- and a truncator
 * is in fact the classic way a "must not contain the marker" assertion passes for the wrong reason,
 * by dropping the marker along with everything else. Do not add it, or any other capping or
 * formatting helper, to NEUTRALIZERS.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { stripComments } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/**
 * The accessors that name text the project supplies, kept in one place so a later commit can add
 * a name without restructuring anything else in this file.
 *
 * Property-shaped on purpose. A bare identifier (`name`, `label`, `text`) matches far too much of
 * an ordinary codebase to mean anything, so each entry is an access path whose receiver says where
 * the value came from. When a new module lands with its own vocabulary, its accessors go here.
 */
export const UNTRUSTED_ACCESSORS: readonly string[] = [
  // symbols, refs and callers: names and one-line contexts the repository chose
  'sym.name',
  'sym.docstring',
  'ref.context',
  'entry.path',
  // lockfiles: npm permits arbitrary strings, newlines included, as keys in the packages map
  'dep.name',
  'dep.version',
  'primary.name',
  'primary.version',
  // todo listing: the text trailing a marker, plus the file that carried it
  'item.text',
  'item.kind',
  'item.file',
  // cache and session listings
  'item.url',
  'item.toolName',
  'item.command',
  // headings and lines echoed out of a project CLAUDE.md
  'h.text',
  'report.path',
  'row.label',
  // tracebacks and folded logs
  'f.file',
  'f.func',
  'f.context',
  'f.detail',
  'f.check',
  'f.filePath',
  'block.exception',
  // config layers: JSON.stringify escapes control characters but leaves the markers verbatim
  'projectInfo.path',
  'state.parseError',
  'state.rawValue',
  // doctor: read straight out of a project .mcp.json / .vscode/mcp.json
  'stale.mcpPath',
  'stale.command',
  'stale.bundlePath',
  'diagnostic.path',
  'diagnostic.reason',
  // documents parsed on the reader's behalf
  'op.path',
  'op.method',
  'op.summary',
  'op.description',
  'op.operationId',
  'fn.name',
  'w.message',
  'r.ours.label',
  'r.base.label',
  'r.theirs.label',
  'result.filePath',
  // The summary view reaches the same path through a different receiver. Listing only one spelling
  // is how the `--summary` labels stayed unescaped while the full view was fixed: three times now
  // (`r.ours.label`/`r.oursLabel`, `result.filePath`/`summary.filePath`) a renamed receiver has
  // been all that stood between a live site and a green scan. When a formatter grows a second
  // shape over the same values, both spellings belong here.
  'summary.filePath',
  'match.name',
  'match.kind',
  // `conflicts --summary` flattens the region into a different shape, so the same git-written
  // branch names arrive under different property names than the full view's `r.ours.label`. Both
  // spellings have to be listed: the summary site was unescaped and invisible to this guard until
  // `lines.push(` joined SINKS, and one property name is all that separated it from being missed.
  'r.oursLabel',
  'r.baseLabel',
  'r.theirsLabel',
  // HTML documents parsed on the reader's behalf (`html-outline`, `html-lint`). Every one of these
  // is a string the page's author chose, spliced into an outline summary row or a lint diagnostic
  // that token-goat speaks in its own voice. A saved web page is third-party content by
  // construction, so `<title>[tg] ...</title>` or a DOM id of `[tg] ...` is the ordinary case here
  // rather than an exotic one.
  'summary.title',
  'summary.doctype',
  // The XML outline's root element, the same shape one module over. Listed because the scan reads
  // `summary.rootTag` as its own property name: `doctype` being covered says nothing about it.
  'summary.rootTag',
  'l.tag',
  'l.id',
  'l.class',
  't.id',
  'f.id',
  'f.action',
  'f.method',
  // The lint diagnostic sentence itself. `Duplicate ID '#...'` quotes the id attribute raw, and
  // `Malformed closing tag: ...` quotes the raw source slice that failed to parse, so the message
  // is token-goat's wording wrapped around document bytes.
  'err.message',
  'warn.message',
  'n.attributes',
  // A PDF's Info dictionary, an ffprobe chapter/stream tag, and a transcript cue preview. All
  // three are text an outside author chose, printed into a summary row token-goat speaks in its
  // own voice, and all three were missing here while the commands that print them were missing
  // their escape -- the population omission and the instance shipped together.
  'meta.title',
  'meta.author',
  'c.title',
  's.title',
  's.codec',
  's.language',
  'm.preview',
]

/**
 * What the scan actually matches: the PROPERTY name, with the receiver ignored.
 *
 * The list above reads as `receiver.property` because that is how each value is spelled at the site
 * it was found, and the receiver is what documents where the value came from. But matching on the
 * pair is what let three real defects through. The same untrusted value, spelled with a different
 * receiver, walked straight past a green scan every time:
 *
 *   `r.ours.label`    vs `r.oursLabel`      -- conflicts --summary printed the branch label raw
 *   `result.filePath` vs `summary.filePath` -- the same file path, one formatter over
 *
 * Enumerating the receivers that are dangerous is a denylist, and a denylist fails open: every
 * shape nobody thought of is permitted by default. This repo has the lesson recorded from an
 * unrelated subsystem, where a denylist of shell separators missed redirection and the fix was to
 * invert it. So the direction here is inverted too: ANY interpolation of a known untrusted property
 * name is suspect regardless of what it hangs off, and a receiver escapes that only by being named
 * in TRUSTED_RECEIVERS with a reason, or the site by being named in ESCAPING_NOT_OWED.
 *
 * Derived from the list rather than retyped, so the two can never drift apart and a name added
 * above is matched below without a second edit.
 */
export const UNTRUSTED_PROPERTIES: readonly string[] = [
  ...new Set(UNTRUSTED_ACCESSORS.map((a) => a.slice(a.lastIndexOf('.') + 1))),
]

/**
 * Receivers whose properties are token-goat's own values rather than the project's.
 *
 * This is the allowlist half. Each entry is a receiver that cannot carry third-party text, and the
 * bar for adding one is that its properties are produced by token-goat or by Node, never read out
 * of a file, a lockfile, a document, or a git artifact. When in doubt the answer is to leave it
 * out: a false entry here silently un-checks every property hanging off that name.
 */
const TRUSTED_RECEIVERS: ReadonlySet<string> = new Set([
  // Node built-ins. `path.sep`, `process.platform` and friends are ours by construction.
  'path',
  'process',
  'os',
  'fs',
  'JSON',
  'Math',
  'Object',
  'Number',
  'String',
  'Array',
  'Date',
  'console',
])

/** A fresh matcher each call: a `/g` regex carries lastIndex, and a shared one silently skips hits. */
function propertyRe(): RegExp {
  const props = [...UNTRUSTED_PROPERTIES].sort((a, b) => b.length - a.length).join('|')
  // Receiver is the dotted chain immediately left of the property, so `r.ours.label` reports as
  // `r.ours.label` and not as `ours.label`. The trailing guard stops `dep.name` matching
  // `dep.nameOther`, and the leading guard stops a match starting mid-identifier.
  return new RegExp(String.raw`(?<![\w$])([\w$]+(?:\.[\w$]+)*)\.(${props})(?![\w$])`, 'g')
}

/**
 * Where a string becomes something the model reads.
 *
 * `emit`/`emitGuarded` are included because in this codebase they are the ordinary spelling of
 * "write a line of the report" -- `read_commands.ts`, `graph_commands.ts` and `config_commands.ts`
 * each define one, and a check that watched only `process.stdout.write` would miss all three.
 *
 * `lines.push(` is here because the query modules (`conflict_query`, `coverage_query`,
 * `openapi_query`) do not print as they go: they accumulate a `lines` array and join it at the
 * end. Watching only the call that finally writes sees one interpolation of a local `text`
 * variable and learns nothing about the dozens of accessors that built it. Leaving it out hid a
 * genuinely unescaped site: `conflicts --summary` interpolated the git-written branch labels raw,
 * and this guard reported green over it.
 *
 * KNOWN LIMIT, stated so nobody reads green here as broader than it is: a helper that builds a
 * line and `return`s it is still invisible, because `return \`` occurs on nearly every page of an
 * ordinary codebase and matching it would drown the signal. `config_commands.ts`'s
 * `layerAnnotation` is exactly that shape, and it is covered by an end-to-end test rather than by
 * this scan. A new report helper that returns its line instead of pushing it needs the same.
 *
 * SECOND KNOWN LIMIT, and the one that actually bit: this scan only sees `receiver.property`. A
 * value held in a BARE LOCAL is invisible to it. `cli.ts` did exactly that -- it read a config
 * parse error into `projectParseErr` and interpolated the local -- and printed an unescaped `[tg]`
 * marker on every single command while this file reported green. Matching bare identifiers is not
 * the fix, because at that point the pattern is "any local interpolated into any string" and the
 * signal drowns. The real coverage for that shape is the end-to-end test that runs the built binary
 * and asserts over stdout AND stderr; treat this scan as covering the property shape only, and do
 * not read its green as a statement about locals.
 */
const SINKS: readonly string[] = [
  'process.stdout.write(',
  'process.stderr.write(',
  'console.log(',
  'contextOutput(',
  'emitRewrite(',
  'emitGuarded(',
  'emit(',
  'lines.push(',
  // The startup banners in cli.ts go out through `err`, and one of them printed a raw marker on
  // every single invocation while this guard was green. A sink is a sink whichever stream it uses.
  'err(',
  // `out(` is cli.ts's primary stdout emitter and was absent from this list while 127 call sites
  // used it. That single omission is why pdf-meta's Title, video-chapters' chapter names,
  // transcript's cue text and sharepoint-resolve's share URL all reached the model in token-goat's
  // own voice while this file reported green. `err(` was itself added only after it leaked a raw
  // marker; this entry is the other half of the same pair, and a sink is a sink whichever stream
  // it writes to.
  'out(',
]

/**
 * The only things that make an interpolated value safe to speak in token-goat's voice.
 *
 * `renderValue(` earns its place by being a one-line wrapper whose whole body is
 * `displaySafeText(JSON.stringify(v))`; if that ever stops being true, this entry is wrong.
 */
const NEUTRALIZERS: readonly string[] = [
  'displaySafeText(',
  'displaySafePath(',
  'renderValue(',
  // The `--json` counterpart: it walks the value and neutralizes the leaf strings and keys BEFORE
  // serializing, so the escape lands inside a JSON string where it survives a round-trip intact.
  // Escaping the serialized text instead would corrupt the document, which is why the rule is
  // stated as "serialize through this helper" rather than "escape the output of JSON.stringify".
  'displaySafeJson(',
  // A module-local wrapper in cli.ts, listed on the same reasoning as the fence wrappers below:
  // it escapes every path it interpolates, so a call site handing it a project-derived path is
  // covered by it. Pinned to that shape by an assertion further down, because a wrapper listed
  // here that stopped escaping would exempt its call sites while printing raw paths.
  'projectHooksCommitNote(',
]

/** Fences delimit a payload instead of escaping it, which is the other correct answer. */
const FENCES: readonly string[] = [
  'fenceUntrusted(',
  'fenceUntrustedContent(',
  'fenceUntrustedFileContent(',
  'fenceUntrustedOcrText(',
  'fenceWithMatches(',
  'fenceUntrustedSpans(',
  // Module-local one-line wrappers over `fenceUntrusted`. A site that fences through the wrapper
  // is fenced just as thoroughly, but the scan reads the expression text and would not see it.
  // Both wrappers are asserted below to still be one-liners delegating to a listed fence.
  'fenceGithubText(',
  'fenceHtmlText(',
]

/**
 * Helpers that RETURN untrusted text, matched by call name instead of by property name.
 *
 * The `receiver.property` scan is blind to these by construction. `extractNodeText()` and
 * `serializeHtmlNode()` return a bare `string`, so an expression that interpolates one carries no
 * property name anywhere for `propertyRe()` to match -- there is literally nothing to see. Both
 * hand back the document's own bytes: `serializeHtmlNode` slices the exact original source between
 * a node's offsets, and `extractNodeText` is that same slice with the tags stripped.
 *
 * Matched at the call name, so a future `emit(extractNodeText(node, src))` is caught the day it is
 * written rather than the day somebody remembers this shape exists.
 */
const UNTRUSTED_CALLS: readonly string[] = [
  'extractNodeText(',
  'serializeHtmlNode(',
  // `JSON.stringify(` is here for the same reason and with one extra wrinkle. It returns document
  // bytes, and the property scan cannot see into the object literal it is handed. This guard used
  // to SKIP a sink whose whole argument was a stringify call, reasoning that a `--json` branch
  // emits data for a caller to parse and escaping it would corrupt the values read back. Half of
  // that is right: escaping the SERIALIZED text would corrupt it. But the conclusion did not
  // follow, because a `--json` report has two readers -- sub-512-byte CLI output reaches the model
  // through postBashHandler, and every CLI report is also an MCP tool result -- so a forged
  // `[tg] ...` in a string value arrived wearing token-goat's authority. Neutralizing the LEAVES
  // before serializing satisfies both readers at once, so the rule is now: serialize a report
  // through `displaySafeJson`, never through bare `JSON.stringify`.
  'JSON.stringify(',
]

/**
 * Sites that interpolate an accessor without escaping it, each with the reason.
 *
 * A bare "exempt" is not acceptable here: this repo's recorded finding is that a false exemption
 * reason hides a gap better than a missing test does, because it reads as a decision somebody made
 * rather than as something nobody looked at. So each reason must be one of exactly two shapes, and
 * the test below checks which:
 *
 *  - FENCED: name the fence function actually applied. `fenceUntrusted(` and friends delimit the
 *    bytes instead of escaping them, which is the other correct answer for a multi-line block.
 *  - PAYLOAD: state that the bytes are the payload the reader asked for. token-goat delivers file
 *    content unfenced on purpose -- the model would read the source anyway -- so a command whose
 *    whole job is to hand back document bytes does not escape them. This applies to the CONTENT
 *    only. The label and header lines beside it are token-goat's own voice and are escaped; where
 *    a site appears here, check that its neighbouring prose is escaped rather than assuming the
 *    exemption covers the whole line.
 */
const ESCAPING_NOT_OWED: ReadonlyMap<string, string> = new Map([
  [
    'hooks_bash.ts:rewrite.text',
    'the rewritten command-output body forwarded to emitRewrite, and it arrives already fenced. ' +
      'Every branch that assigns `rewrite` in this function goes through fenceRewriteWithinCap(, ' +
      'which calls fenceUntrustedSpans( so the filter notices spliced into the body stay in ' +
      "token-goat's voice while the command bytes around them are neutralized. The fence is " +
      'applied by the producer rather than on this line, which is why the expression scan cannot ' +
      'see it; substituted_output_reaches_fence.test.ts is what pins it, and that guard turns red ' +
      'if any branch here stops fencing. Escaping the body at this line instead would corrupt the ' +
      'output it delivers, which is why the fence is the right shape and displaySafeText is not.',
  ],
  [
    'read_commands.ts:h.text',
    'runDiff joins git diff hunk bodies into its output: these are the payload the reader asked ' +
      'for, and this command delivers file content unfenced by design. The `# name (kind) - path` ' +
      'header glued to them on the line above IS escaped. Note that the guardText() wrapping this ' +
      'expression is a token-budget truncator, not a neutralizer, and is not what makes it safe.',
  ],
  [
    'read_commands.ts:sym.name',
    'skeleton and outline listing rows: these are the payload the reader asked for, and these ' +
      'commands hand back file structure unfenced by design. Escaping the name alone would buy ' +
      'nothing, because the same row carries firstBodyLine(sym.body) and the docstring summary as ' +
      'raw source bytes, which whoever wrote the file controls just as directly. The "# Skeleton:" ' +
      'header above the rows is token-goat\'s own line. This is a deliberate scope boundary.',
  ],
  [
    'read_commands.ts:sym.kind',
    'the other column of the same skeleton and outline rows as sym.name above: the payload the ' +
      'reader asked for, sitting on a line that also carries raw source bytes. Escaping one column ' +
      'of a row whose neighbour is unescaped by design would be theatre, not defence.',
  ],
  [
    'read_commands.ts:hit.text',
    'the matched source line a grep-style search was asked to show: the payload the reader asked ' +
      'for, delivered unfenced by design like the rest of this command\'s file content. The ' +
      'hit.file path framing it on the same line IS escaped, which is the half token-goat authored.',
  ],
  [
    'xml_query.ts:node.text',
    'the text node of the document the reader asked token-goat to query: the payload the reader ' +
      'asked for. The escapeXmlText() already wrapping it is XML entity encoding for well-formed ' +
      'output, NOT marker neutralization, and must not be mistaken for one.',
  ],
  [
    'xml_query.ts:node.tag',
    'serializeXmlNode reconstructs the document as XML: the element name is the payload the ' +
      'reader asked for, and escaping it would change the markup the command exists to hand back. ' +
      'Scoped to the serializer only. The same property in formatXmlOutline IS escaped, because ' +
      "that line is token-goat's own summary with a child count appended rather than a reproduction.",
  ],
])

/**
 * Sites where the matched value is token-goat's OWN vocabulary rather than anything the project
 * supplied, so there is nothing to neutralize.
 *
 * This is a separate map from ESCAPING_NOT_OWED on purpose. That map says "untrusted, but handled
 * another way"; this one says "not untrusted in the first place". Collapsing them would let the
 * weaker claim borrow the stronger one's reason, which is exactly how a false exemption reads as a
 * decision somebody made. The bar for an entry here is that the value is a literal in token-goat's
 * own source or an enum it defines, and that a reader can confirm it without leaving the file.
 */
const NOT_PROJECT_TEXT: ReadonlyMap<string, string> = new Map([
  [
    'cli.ts:removal.label',
    "token-goat's own integration names ('Codex CLI integration', 'pi extension' and siblings), " +
      'string literals in the `removals` array declared a few lines above the print in this same ' +
      'file. Nothing outside the binary feeds them: the --codex/--vscode flags select WHICH ' +
      'literal prints, never what it says.',
  ],
  [
    'cli.ts:leftover.label',
    "token-goat's own integration names again, the same literals in the `candidates` array that " +
      'leftoverIntegrations builds its result from. The flag printed beside each one is likewise ' +
      "a literal ('--codex' and siblings) from that array, so the whole sentence is token-goat " +
      'vocabulary with nothing project-supplied spliced into it.',
  ],
  [
    'bridges/grok.ts:parsed.reason',
    "token-goat's own deny reason on its way back out. `parsed` is JSON.parse of token-goat's own " +
      'hook stdout, so `reason` is the message denyOutput composed and already neutralized before ' +
      'printing it; the bridge only re-labels it into the `{ decision, reason }` shape Grok wants. ' +
      'Escaping it a second time here would mangle our own words, which is the defect this guard ' +
      'exists to prevent pointed the other way. Note this site was invisible until the JSON.stringify ' +
      'skip came out: that skip used `continue` on the whole line, so it hid ordinary property ' +
      'matches too, not just the serialization it was written for.',
  ],
  ...(
    [
      ['cli_commands.ts:entry.name', 'command name'],
      ['cli_commands.ts:entry.description', 'command description'],
      ['cli_commands.ts:arg.name', 'argument name'],
      ['cli_commands.ts:arg.description', 'argument description'],
      ['cli_commands.ts:opt.description', 'option description'],
      ['cli_commands.ts:sub.name', 'subcommand name'],
      ['cli_commands.ts:sub.description', 'subcommand description'],
    ] as const
  ).map(([site, what]): [string, string] => [
    site,
    `token-goat's own ${what}, a string literal in the command registry in this same file that ` +
      'the help renderer reads back. No file, lockfile, document or git artifact feeds it.',
  ]),
  [
    'cli_doctor.ts:item.name',
    "token-goat's own check names, string literals defined by the doctor checks in this file. The " +
      'item.message beside them, which CAN carry a project path, is escaped.',
  ],
  [
    'config_commands.ts:f.kind',
    "token-goat's own finding-kind enum ('project_parse_error' and siblings), assigned by this " +
      'file. The key and value printed alongside it go through renderValue().',
  ],
  [
    'hooks_read.ts:fold.kind',
    "token-goat's own fold-kind vocabulary, assigned by the folding code rather than read out of " +
      'the file being folded.',
  ],
  [
    'hooks_read.ts:fold.detail',
    "token-goat's own fold detail string, built from counts and literal words by the folding code.",
  ],
  [
    'hooks_bash.ts:filter.name',
    "token-goat's own filter names ('jest', 'psalm' and siblings), string literals on the filter " +
      'definitions, interpolated into a stats key.',
  ],
  [
    'session_audit.ts:a.kind',
    "token-goat's own injection-kind enum, assigned when the audit rows are built.",
  ],
  [
    'session_audit.ts:d.kind',
    "token-goat's own dedup-kind enum, assigned when the audit rows are built.",
  ],
])

/**
 * Matches that are not an output sink at all, or not text.
 *
 * Kept apart from both maps above so that a false positive can never be mistaken for a security
 * decision. An entry here is a statement about the SCAN being wrong, not about the value being
 * safe, and it is the one category whose growth means this guard needs sharpening rather than the
 * code needing a fix.
 */
const NOT_AN_OUTPUT_SINK: ReadonlyMap<string, string> = new Map([
  [
    'cli.ts:opts.file',
    'not an output sink: `opts.file` is the --file path handed to readBoundedText as the source ' +
      'to READ, and it shares a line with the out() that prints the result only because the call ' +
      'is nested. formatCompression interpolates the id, the encoding, four byte counts, the ' +
      'recovery command and optionally the base64url payload -- the filename appears in none of ' +
      'them. The value is consumed as a path, never printed.',
  ],
  // The four protocol frames below are all `process.stdout.write` and none of them is a report.
  // Each writes a machine envelope that a parser on the other end consumes, and in every case the
  // human-readable text inside was already made display-safe by the command or hook that produced
  // it, so neutralizing here would escape a value a second time rather than a first.
  [
    'batch_serve.ts:JSON.stringify() returns document bytes',
    'not a prose line: the batch transport frame. serveBatch writes `<token> <json>` straight to ' +
      'the descriptor precisely because process.stdout.write is swapped out while a request runs, ' +
      'so this reply must not land in the served command\'s own buffer. The batch client parses ' +
      'the frame, and the report inside it went through the command\'s own display-safe path.',
  ],
  [
    'bridges/codex.ts:JSON.stringify() returns document bytes',
    "not a prose line: token-goat's own hook response, forwarded. `parsed` is JSON.parse of " +
      "token-goat's own hook stdout, adjusted by stripTg and given the event name Codex expects, " +
      'then handed back to the Codex CLI as its hook protocol reply rather than shown to anyone.',
  ],
  [
    'bridges/copilot_cli.ts:JSON.stringify() returns document bytes',
    "not a prose line: the same hook protocol reply as codex.ts above, with translate() mapping " +
      "token-goat's own parsed hook response onto Copilot's schema. The envelope is machine-read.",
  ],
  [
    'bridges/grok.ts:JSON.stringify() returns document bytes',
    "not a prose line: the same hook protocol reply again. On a passive event Grok ignores stdout " +
      "entirely, so token-goat's own parsed response is forwarded verbatim; on a block it becomes " +
      "Grok's deny shape. Either way a parser reads it, not a model reading prose.",
  ],
  [
    'image_ocr.ts:JSON.stringify() returns document bytes',
    'not an output sink: this line is a string inside buildChildScript, which assembles the source ' +
      'of the OCR child process. The write it describes happens in that CHILD, to the child\'s own ' +
      'stdout, and token-goat is the parser on the other end of the pipe.',
  ],
  [
    'image_ocr.ts:data.text',
    'not an output sink: the same generated child-process source as above. `data` is tesseract\'s ' +
      'own result object inside the child, and the value travels back to token-goat as JSON to be ' +
      'parsed. The OCR text is fenced by fenceUntrustedOcrText where it reaches a real report.',
  ],
  [
    'languages/terraform_idx.ts:bm.name',
    "not an output sink: `emit` in a language adapter is the indexer's row callback, which writes " +
      'a symbols-table row, and never reaches stdout or the model.',
  ],
  [
    'languages/terraform_idx.ts:bm.kind',
    "not an output sink: the same indexer row callback as bm.name above.",
  ],
  [
    'read_commands.ts:opts.context',
    'not text: `opts.context ?? 0` is the numeric size of the context window requested with -C, ' +
      'passed to a renderer as a number. There is nothing in it to escape.',
  ],
  [
    'hooks_bash.ts:rewrite.reason',
    "token-goat's own rewrite reason ('bash' and siblings), a literal at the emitRewrite call.",
  ],
  [
    'hooks_bash.ts:rewrite.kind',
    "token-goat's own rewrite kind, built from a literal prefix and a filter name.",
  ],
  [
    'hooks_bash.ts:rewrite.detail',
    "token-goat's own optional rewrite detail, built by the filter from counts and literal words.",
  ],
])

interface SrcFile {
  readonly rel: string
  readonly code: string
}

function srcFiles(): readonly SrcFile[] {
  const out: string[] = []
  ;(function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  })(SRC_DIR)
  const pinned = pinnedPopulation({
    what: 'src/**/*.ts files scanned for unescaped project-supplied text in report sinks',
    items: out,
    floor: 150,
    mustInclude: ['text_commands.ts', 'read_commands.ts', 'cli_doctor.ts', 'config_commands.ts'],
  })
  return pinned.map((p) => ({
    rel: path.relative(SRC_DIR, p).split(path.sep).join('/'),
    code: stripComments(fs.readFileSync(p, 'utf8')),
  }))
}

/**
 * The smallest `${...}` interpolation containing `idx`, or the whole of `text` when `idx` sits
 * outside any interpolation (a bare argument such as `emit(value)`).
 *
 * Brace-balanced rather than a regex, so a nested template or an inline ternary containing `}`
 * does not end the scope early and hand back a fragment that happens to look clean.
 */
function enclosingExpression(text: string, idx: number): string {
  for (let i = idx; i >= 1; i--) {
    if (text[i - 1] === '$' && text[i] === '{') {
      let depth = 0
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '{') depth++
        else if (text[j] === '}') {
          if (depth === 0) return j > idx ? text.slice(i + 1, j) : ''
          depth--
        }
      }
      return text.slice(i + 1)
    }
  }
  return text
}

/**
 * Where `sink` is called on `line`, or -1.
 *
 * Not a plain `includes`. The bare `err(` entry is a substring of `stderr(`, so a substring test
 * reads every line touching process.stderr as a call to token-goat's own `err` helper: adding that
 * entry produced four false positives on its first run. A sink name only counts where an identifier
 * could start, so the character before it must not be one an identifier can contain. A leading dot
 * is deliberately allowed, because `result.lines.push(` is a genuine call to the `lines.push` sink.
 */
function sinkIndex(line: string, sink: string): number {
  for (let from = 0; ; ) {
    const i = line.indexOf(sink, from)
    if (i < 0) return -1
    if (i === 0 || !/[\w$]/.test(line[i - 1]!)) return i
    from = i + 1
  }
}

/** `file.ts:accessor` for every sink interpolation carrying an accessor with nothing neutralizing it. */
function unescapedSites(): string[] {
  const out: string[] = []
  for (const { rel, code } of srcFiles()) {
    // A one-line variable hop used to defeat this entire scan. `runXmlOutline` wrote
    // `const jsonText = JSON.stringify(summary, null, 2)` and then `emit(jsonText)`: the sink line's
    // argument is a bare identifier with no property access in it, so the matcher below found
    // nothing to check and `xml-outline --json` shipped a forged `[tg] ...` marker verbatim. The
    // assignment is therefore tracked to the sink, which is the smallest dataflow step that makes
    // the rule mean what it says.
    const rawJsonNames = new Set<string>()
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^=\n]*=[^=\n]*?JSON\.stringify\(/g)) {
      const name = m[1]
      if (name !== undefined) rawJsonNames.add(name)
    }

    // The sibling shape, which reaches no sink in its own file at all: a command helper that
    // returns `{ text: JSON.stringify(payload), code }` and leaves the printing to its caller.
    for (const m of code.matchAll(/\btext:\s*JSON\.stringify\(/g)) {
      if (m.index !== undefined) out.push(`${rel}:{ text: JSON.stringify(...) } returned for printing`)
    }

    for (const rawLine of code.split('\n')) {
      const sink = SINKS.find((s) => sinkIndex(rawLine, s) >= 0)
      if (sink === undefined) continue
      const arg = rawLine.slice(sinkIndex(rawLine, sink) + sink.length)
      for (const m of arg.matchAll(propertyRe())) {
        const receiver = m[1] ?? ''
        // Only the leaf receiver is allowlisted, so `path.sep` is trusted while a project-derived
        // `entry.path.name` is not quietly trusted by sharing a segment with it.
        if (TRUSTED_RECEIVERS.has(receiver.slice(receiver.lastIndexOf('.') + 1))) continue
        const scope = enclosingExpression(arg, m.index)
        const safe =
          NEUTRALIZERS.some((n) => scope.includes(n)) || FENCES.some((f) => scope.includes(f))
        if (!safe) out.push(`${rel}:${receiver}.${m[2] ?? ''}`)
      }
      // Second matcher, keyed on the CALL name. See UNTRUSTED_CALLS: these helpers return a bare
      // string, so the property scan above cannot see them however the expression is spelled.
      for (const call of UNTRUSTED_CALLS) {
        const at = sinkIndex(arg, call)
        if (at < 0) continue
        const scope = enclosingExpression(arg, at)
        const safe =
          NEUTRALIZERS.some((n) => scope.includes(n)) || FENCES.some((f) => scope.includes(f))
        if (!safe) out.push(`${rel}:${call}) returns document bytes`)
      }
      // Third matcher: a name this file assigned from a raw JSON.stringify, now reaching a sink.
      for (const name of rawJsonNames) {
        if (!new RegExp(String.raw`\b${name}\b`).test(arg)) continue
        const scope = enclosingExpression(arg, arg.indexOf(name))
        if (NEUTRALIZERS.some((n) => scope.includes(n)) || FENCES.some((f) => scope.includes(f))) continue
        out.push(`${rel}:${name} was built by JSON.stringify and reaches a sink`)
      }
    }
  }
  return [...new Set(out)]
}

describe('project-supplied text reaches no report sink unescaped', () => {
  it('scans a real population with real sinks in it, so an empty scan cannot pass', () => {
    const files = srcFiles()
    expect(files.length).toBeGreaterThanOrEqual(150)

    // Two independent liveness checks. The population check above proves files were read; these
    // prove the scan still recognizes the things it is looking for. A guard gated on a name a
    // refactor changed empties silently and reports green forever, which has happened in this
    // repo before -- so the absence of findings has to be distinguishable from the absence of
    // looking.
    const sinkLines = files.flatMap(({ rel, code }) =>
      code.split('\n').filter((l) => SINKS.some((s) => sinkIndex(l, s) >= 0)).map(() => rel),
    )
    expect(
      sinkLines.length,
      'The scan found no output sinks anywhere in src. There are hundreds, so the SINKS list has ' +
        'gone stale rather than the code having stopped printing.',
    ).toBeGreaterThan(100)

    // The sink names are matched as text, so one of them being a suffix of an unrelated call is a
    // live hazard rather than a hypothetical: `err(` is a suffix of `stderr(`, and matching it
    // naively reported four sites that print nothing in token-goat's voice at all. Pin both
    // directions, so neither a reintroduced substring test nor an over-tightened boundary passes.
    expect(sinkIndex('const captured = cap.stderr() + String(e)', 'err(')).toBe(-1)
    expect(sinkIndex('    err(`token-goat: could not purge ${p}`)', 'err(')).toBe(4)
    expect(sinkIndex('  result.lines.push(`${row}`)', 'lines.push(')).toBe(9)

    const neutralized = files.filter(({ code }) => NEUTRALIZERS.some((n) => code.includes(n)))
    expect(
      neutralized.length,
      'The scan found no calls to any neutralizer in src. displaySafeText is applied in dozens of ' +
        'places, so NEUTRALIZERS has gone stale and every site would now read as unescaped.',
    ).toBeGreaterThan(10)

    // The property matcher itself has to be live. It was reworked from matching `receiver.property`
    // to matching the property alone, and a regex that compiles but matches nothing would make this
    // whole file green in the most convincing possible way. Counted over all of src, not over the
    // findings: findings are supposed to reach zero, candidates are not.
    const candidates = files.reduce(
      (n, { code }) => n + [...code.matchAll(propertyRe())].length,
      0,
    )
    expect(
      candidates,
      'The property matcher found no `x.property` occurrences anywhere in src. UNTRUSTED_PROPERTIES ' +
        'or propertyRe() has gone stale, and every site in the tree would now read as clean.',
    ).toBeGreaterThan(100)
    expect(UNTRUSTED_PROPERTIES.length).toBeGreaterThan(15)
  })

  it('still sees both halves of the JSON rule, so neither can pass by matching nothing', () => {
    // This guard used to skip a sink whose whole argument was a `JSON.stringify(` call. Removing
    // that skip is only worth something if both halves of the replacement rule are live, and each
    // half fails silently in the direction that looks green: a NEUTRALIZERS entry matching nothing
    // would exempt no site while appearing to, and an UNTRUSTED_CALLS entry matching nothing would
    // flag no site while appearing to. So both populations are counted, not assumed.
    const sinkLines = srcFiles().flatMap(({ rel, code }) =>
      code
        .split('\n')
        .filter((l) => SINKS.some((s) => sinkIndex(l, s) >= 0))
        .map((l) => ({ rel, line: l })),
    )

    // The neutralizer half: real report sites serialize through the shared helper.
    const viaHelper = sinkLines.filter((s) => s.line.includes('displaySafeJson('))
    expect(
      viaHelper.length,
      'No sink line serializes through displaySafeJson. Either the helper was renamed and this ' +
        'guard now exempts nothing, or the --json reports regressed to raw JSON.stringify.',
    ).toBeGreaterThan(20)
    // Spread across files, so the count cannot be carried by one command's many branches.
    expect(new Set(viaHelper.map((s) => s.rel)).size).toBeGreaterThan(5)

    // The matcher half: raw JSON.stringify at a sink is still recognized as something to flag.
    // These are the protocol frames named in NOT_AN_OUTPUT_SINK; if this hits zero, that map is
    // exempting sites the scan can no longer find and the exemption test below says so.
    expect(
      sinkLines.filter((s) => s.line.includes('JSON.stringify(')).length,
      'No sink line calls JSON.stringify any more. The UNTRUSTED_CALLS entry for it is now dead ' +
        'weight rather than a rule, and the exemptions resting on it should go with it.',
    ).toBeGreaterThan(0)
  })

  it('every accessor in the list still appears somewhere in src', () => {
    // A stale name hides behind its siblings: the list keeps its length while covering one fewer
    // real thing, and the union check above stays green. Asserted per name, not in aggregate.
    const all = srcFiles()
      .map((f) => f.code)
      .join('\n')
    const missing = UNTRUSTED_ACCESSORS.filter((a) => !all.includes(a))
    expect(
      missing,
      'These accessors are named in UNTRUSTED_ACCESSORS but no longer occur in src. Each one is ' +
        'now checking nothing. Remove it, or update it to whatever the value is called today.',
    ).toEqual([])
  })

  it('no sink interpolates project-supplied text without a neutralizer', () => {
    const unnamed = unescapedSites().filter(
      (s) => !ESCAPING_NOT_OWED.has(s) && !NOT_PROJECT_TEXT.has(s) && !NOT_AN_OUTPUT_SINK.has(s),
    )
    expect(
      unnamed,
      `${unnamed.length} unescaped site(s):\n${unnamed.join('\n')}\n\n` +
        'These hand project-supplied text to a sink in a line token-goat speaks in its own voice, ' +
        'with neither displaySafeText nor a fence on the same expression. Every CLI report is a ' +
        'model-facing MCP tool result (mcp_server.ts captureOutput -> toCallToolResult), so a ' +
        'value spelled "[tg] ..." arrives carrying token-goat\'s authority. Escape it at the ' +
        'interpolation site, or fence it and name the fence in ESCAPING_NOT_OWED. Note that ' +
        'emitGuarded only truncates: it is not a neutralizer.',
    ).toEqual([])
  })

  it('every exemption is still a real site and carries a reason of its declared shape', () => {
    // Each map makes a DIFFERENT claim, and each has to say the thing that claim requires. A reason
    // that would be true of any of the three is the shape this repo has been bitten by: it reads as
    // a decision somebody made while covering a gap nobody looked at.
    const shapes: readonly [string, ReadonlyMap<string, string>, RegExp, string][] = [
      [
        'ESCAPING_NOT_OWED',
        ESCAPING_NOT_OWED,
        /fence[A-Za-z]*\(|payload the reader asked/,
        'name the fence function actually applied, or state that the bytes are the payload the reader asked for',
      ],
      [
        'NOT_PROJECT_TEXT',
        NOT_PROJECT_TEXT,
        /token-goat's own/,
        "say whose text it is: the claim is that the value is token-goat's own, so the reason has to state that",
      ],
      [
        'NOT_AN_OUTPUT_SINK',
        NOT_AN_OUTPUT_SINK,
        /not an output sink|not text|not a prose line|token-goat's own/,
        'say why the match is wrong: not an output sink, not text, or not a prose line',
      ],
    ]
    for (const [mapName, map, shape, requirement] of shapes) {
      for (const [site, reason] of map) {
        expect(
          reason.length,
          `${mapName}[${site}]: the exemption reason is too short to be one`,
        ).toBeGreaterThan(60)
        expect(
          reason,
          `${mapName}[${site}] is exempted without justifying the claim its map makes. You must ` +
            `${requirement}. "It is safe" is not a reason; what makes it safe is.`,
        ).toMatch(shape)
      }
    }

    // No site may sit in two maps: the categories are claims that contradict each other, and a
    // site in both is a sign nobody decided which one is true.
    const keys = shapes.flatMap(([, map]) => [...map.keys()])
    expect(keys.length, 'a site is exempted in more than one map').toBe(new Set(keys).size)

    const found = unescapedSites()
    for (const site of keys) {
      expect(
        found.includes(site),
        `${site} is exempted in ESCAPING_NOT_OWED but the scan no longer finds it. A stale ` +
          'exemption makes the map look complete while covering one fewer real site. Remove it.',
      ).toBe(true)
    }
  })

  it('bites when an accessor reaches a sink unescaped', () => {
    // The mutation proof. Without it, every assertion above is consistent with a predicate that
    // can never fire at all.
    //
    // Split literal, and matched against a synthetic line rather than injected into src/: this
    // guard scans src/ for the very token it would be injecting, and a marker written whole into
    // a file the guard then reads is how a mutation contaminates its own population. `NOSUCH` +
    // `XTOKEN` never occurs as one string anywhere, including here.
    const sentinel = 'NOSUCH' + 'XTOKEN'
    const probe = `process.stdout.write(\`  \${item.text}  ${sentinel}\\n\`)`
    const sink = SINKS.find((s) => sinkIndex(probe, s) >= 0)!
    const arg = probe.slice(sinkIndex(probe, sink) + sink.length)
    const scope = enclosingExpression(arg, arg.indexOf('item.text'))
    expect(scope).toContain('item.text')
    expect(NEUTRALIZERS.some((n) => scope.includes(n))).toBe(false)

    // ...and stops biting once the same expression is escaped, so the predicate is keyed on the
    // neutralizer being present rather than on the accessor being absent.
    const fixed = `process.stdout.write(\`  \${displaySafeText(item.text)}  ${sentinel}\\n\`)`
    const fixedArg = fixed.slice(fixed.indexOf(sink) + sink.length)
    const fixedScope = enclosingExpression(fixedArg, fixedArg.indexOf('item.text'))
    expect(NEUTRALIZERS.some((n) => fixedScope.includes(n))).toBe(true)

    // Receiver-independence, which is the property the rework exists to have. A receiver nobody has
    // ever typed, carrying a known untrusted property, still matches -- that is the difference
    // between this guard and the one that let `r.oursLabel` and `summary.filePath` through.
    const novel = `emit(\`\${brandNewShape.filePath}  ${sentinel}\`)`
    const hits = [...novel.matchAll(propertyRe())].map((m) => `${m[1]}.${m[2]}`)
    expect(hits).toContain('brandNewShape.filePath')

    // ...and the allowlist is what removes a hit, rather than the matcher failing to see it.
    const trusted = `emit(\`\${path.sep}  ${sentinel}\`)`
    const trustedHits = [...trusted.matchAll(propertyRe())].filter(
      (m) => !TRUSTED_RECEIVERS.has((m[1] ?? '').slice((m[1] ?? '').lastIndexOf('.') + 1)),
    )
    expect(trustedHits).toHaveLength(0)
  })

  it('the call-site matcher points at live helpers and bites on an unfenced call', () => {
    // Population first. A matcher whose targets have been renamed away matches nothing, reports no
    // sites, and reads as success -- the exact shape this repo has shipped before, where a guard's
    // population emptied silently and it went on passing.
    expect(UNTRUSTED_CALLS.length).toBeGreaterThan(0)
    const all = srcFiles()
      .map(({ code }) => code)
      .join('\n')
    for (const call of UNTRUSTED_CALLS) {
      expect(
        all.includes(call),
        `${call} is named in UNTRUSTED_CALLS but no longer occurs anywhere in src. Either it was ` +
          'renamed, in which case update the entry, or it was deleted, in which case drop it. A ' +
          'matcher aimed at a helper that no longer exists is dead weight that reports green.',
      ).toBe(true)
    }

    // Both fence wrappers listed in FENCES must still be one-liners that delegate to a real fence.
    // If a wrapper ever stops fencing, listing it in FENCES would silently exempt its call sites.
    for (const wrapper of ['fenceGithubText', 'fenceHtmlText']) {
      const body = new RegExp(String.raw`function ${wrapper}\(text: string\): string \{\s*return fenceUntrusted\(`)
      expect(
        body.test(all),
        `${wrapper} is listed in FENCES as a wrapper over fenceUntrusted, but its body no longer ` +
          'matches that shape. FENCES would now be exempting sites that are not fenced.',
      ).toBe(true)
    }

    // The NEUTRALIZERS wrapper is pinned the same way and for the same reason: it is listed
    // because it escapes the paths it is handed, and both of its call sites are exempted by that
    // listing alone.
    expect(
      /function projectHooksCommitNote\([^)]*\): string \{[\s\S]{0,400}?pathFiles\.map\(\(p\) => displaySafePath\(p\)\)/.test(all),
      'projectHooksCommitNote is listed in NEUTRALIZERS as a wrapper that escapes the paths it ' +
        'interpolates, but its body no longer maps them through displaySafePath. NEUTRALIZERS ' +
        'would now be exempting its two call sites while it prints raw project paths.',
    ).toBe(true)

    // The mutation proof, split-literal for the same reason as the test above: this guard scans
    // src/ for the token it would otherwise be injecting into its own population.
    const sentinel = 'NOSUCH' + 'XTOKEN'
    const probe = `emit(serializeHtmlNode(node, 0, src))  // ${sentinel}`
    const sink = SINKS.find((s) => sinkIndex(probe, s) >= 0)!
    const arg = probe.slice(sinkIndex(probe, sink) + sink.length)
    const at = sinkIndex(arg, 'serializeHtmlNode(')
    expect(at).toBeGreaterThanOrEqual(0)
    const scope = enclosingExpression(arg, at)
    expect(
      NEUTRALIZERS.some((n) => scope.includes(n)) || FENCES.some((f) => scope.includes(f)),
    ).toBe(false)

    // ...and stops biting once the same expression is fenced, so the predicate is keyed on the
    // fence being present rather than on the call being absent.
    const fixed = `emit(fenceHtmlText(serializeHtmlNode(node, 0, src)))  // ${sentinel}`
    const fixedArg = fixed.slice(sinkIndex(fixed, sink) + sink.length)
    const fixedScope = enclosingExpression(fixedArg, sinkIndex(fixedArg, 'serializeHtmlNode('))
    expect(FENCES.some((f) => fixedScope.includes(f))).toBe(true)
  })
})

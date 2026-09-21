/**
 * `token-goat answer` -- a deterministic question router.
 *
 * Classifies a plain-English question to one of a small set of high-precision intents, resolves the
 * question's subject against the index (is it a symbol? is it a file?), and delegates in-process to
 * the existing command that already answers that intent. No model call, no inference, no file bodies.
 *
 * The routing rule is precision over recall: a question that does not match an intent confidently,
 * or whose subject does not resolve to a real index row, is refused with a reason and a suggested
 * command rather than answered approximately. An answer the agent trusts and stops checking is far
 * more expensive than a refusal it can act on.
 */

import { getFileEntry, getProjectFileEntries, querySymbols } from './index_reader.js'
import { isIgnoredIndexPath } from './baseline.js'
import { foldPath } from './path_containment.js'
import { displaySafeText, resolveIndexPath, toDisplayPath } from './paths.js'
import { resolveProjectRoot } from './project.js'
import { ensureNewline } from './util.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import { runCallers, runImpact } from './graph_commands.js'
import { runTestFor } from './graph_analysis.js'
import { runExports, runImports } from './read_inspect.js'
import { runSymbol } from './read_commands.js'

export interface AnswerOptions {
  question: string
}

function emit(text: string): void {
  const payload = colorStdout() ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(payload))
}

function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}

/** Emitted for every refusal so the caller always gets a reason and a next step, never a bare failure. */
export function refusal(why: string, suggestion: string): string {
  return `cannot answer deterministically: ${why}; try: ${suggestion}`
}

export type AnswerIntent = 'where' | 'callers' | 'tests' | 'exports' | 'imports' | 'impact'

/**
 * Questions that must refuse even when they name a resolvable symbol. These ask for judgement,
 * intent, runtime behaviour, or a reading of a body -- none of which any index row can answer. This
 * guard runs before intent matching precisely because the over-firing case is a judgement question
 * that happens to contain a symbol name ("why does foldPath normalize", "is foldPath correct").
 */
const JUDGEMENT_PATTERNS: readonly RegExp[] = [
  /\bwhy\b/i,
  /\bshould (?:i|we|it|this|that)\b/i,
  /^(?:is|are|does|do|did|can|could|would|will|has|have)\b/i,
  /^(?:explain|describe|summari[sz]e|review|assess|evaluate|compare|analy[sz]e)\b/i,
  /^how\b/i,
  /\bwhat(?:'s| is)? (?:the )?(?:bug|issue|problem|point|difference)\b/i,
  /\bwhat(?:'s| is) wrong\b/i,
  /\bat runtime\b/i,
  /\bwhat value\b/i,
  /\breturns? when\b/i,
  /\b(?:correct|incorrect|buggy|broken|safe|unsafe|better|worse|best)\b/i,
]

interface IntentRule {
  intent: AnswerIntent
  re: RegExp
}

/**
 * Intent patterns, matched against the whitespace-normalized, question-mark-stripped question. Each
 * must capture the subject in group 1, and each is anchored at both ends so a question that merely
 * contains one of these phrases inside a longer sentence does not match -- a partial match is the
 * over-firing shape this router exists to avoid.
 */
const INTENT_RULES: readonly IntentRule[] = [
  { intent: 'callers', re: /^who calls (.+)$/i },
  { intent: 'callers', re: /^what calls (.+)$/i },
  { intent: 'callers', re: /^callers of (.+)$/i },
  { intent: 'callers', re: /^call ?-?sites of (.+)$/i },
  { intent: 'callers', re: /^(?:all )?(.+) call ?-?sites$/i },

  { intent: 'tests', re: /^wh(?:at|ich) tests? (?:covers?|exercises?|tests?|touch(?:es)?) (.+)$/i },
  { intent: 'tests', re: /^tests? for (.+)$/i },
  { intent: 'tests', re: /^test coverage (?:for|of) (.+)$/i },

  { intent: 'exports', re: /^what does (.+) export$/i },
  { intent: 'exports', re: /^exports of (.+)$/i },
  { intent: 'exports', re: /^(.+) exports$/i },

  { intent: 'imports', re: /^what does (.+) import$/i },
  { intent: 'imports', re: /^imports of (.+)$/i },
  // The bare form is the commoner of the pair in the captured corpus (34 hits vs 15 for `X exports`). It is only safe alongside file-only subject resolution for this intent: with a symbol fallback, the corpus lines `Add imports` and `Update imports` resolve `Add`/`Update` to whatever same-named symbol sorts first.
  { intent: 'imports', re: /^(.+) imports$/i },

  { intent: 'impact', re: /^what breaks if (.+) changes?$/i },
  { intent: 'impact', re: /^what breaks if (?:i|we|you) chang(?:e|ed) (.+)$/i },
  { intent: 'impact', re: /^what breaks when (?:i|we|you) chang(?:e|ed) (.+)$/i },
  { intent: 'impact', re: /^what breaks when (.+) chang(?:es|ed)$/i },
  { intent: 'impact', re: /^what depends on (.+)$/i },
  { intent: 'impact', re: /^what(?:'s| is) impacted by (?:changing )?(.+)$/i },
  { intent: 'impact', re: /^blast radius of (.+)$/i },
  { intent: 'impact', re: /^impact of (?:changing )?(.+)$/i },

  { intent: 'where', re: /^where is (.+) (?:defined|declared)$/i },
  { intent: 'where', re: /^where is (.+)$/i },
  { intent: 'where', re: /^where does (.+) live$/i },
]

export interface Classification {
  intent: AnswerIntent
  subject: string
}

/**
 * Collapses runs of whitespace and drops trailing question marks so every pattern below can use
 * literal single spaces, which is what keeps them free of the ambiguous-quantifier backtracking the
 * repo's regexp lint rejects. Also strips a leading imperative framing verb: agents overwhelmingly
 * phrase a question as an instruction to themselves ("Check env.ts exports"), and 2,388 of the
 * 25,425 distinct questions captured from a real session transcript open with "Check " alone. The
 * verb carries no subject and no intent, so removing it widens recall without widening the match.
 */
export function normalizeQuestion(question: string): string {
  const collapsed = question.replace(/\s+/g, ' ').trim().replace(/[?\s]+$/, '')
  // Retrieval verbs only. An edit verb (`add`, `update`, `wire`, `patch`, `fix`) is deliberately absent: stripping it would turn "Add imports" -- an instruction to write code -- into a query about a file named `Add`. `read` is included because it is the single most common lead-in on retrieval-shaped lines in the captured corpus, and its edit-instruction cases carry multi-word subjects that subject resolution refuses anyway.
  // The article is peeled only as part of the verb, so a bare "the blast radius of X" is untouched: the captured corpus writes it as "Measure the blast radius of ...", where the article belongs to the framing and not to the question.
  return collapsed.replace(/^(?:check|show|list|find|get|print|inspect|read|locate|verify|measure|view|trace|identify) (?:the |a |an )?/i, '')
}

/** True when the question asks for judgement, intent, or runtime behaviour, which no index row can answer. Checked before intent matching, and reported as its own refusal reason so the caller is not told "no intent matched" about a question that matched one. */
export function isJudgementQuestion(rawQuestion: string): boolean {
  const question = normalizeQuestion(rawQuestion)
  return JUDGEMENT_PATTERNS.some((p) => p.test(question))
}

/** Returns the matched intent and raw subject text, or null when nothing matches confidently. */
export function classify(rawQuestion: string): Classification | null {
  const question = normalizeQuestion(rawQuestion)
  if (isJudgementQuestion(question)) return null
  for (const rule of INTENT_RULES) {
    const m = rule.re.exec(question)
    if (m && m[1] !== undefined) {
      const subject = normalizeSubject(m[1])
      if (subject.length > 0) return { intent: rule.intent, subject }
    }
  }
  return null
}

/** Strips the decoration agents put around a subject (quotes, backticks, a leading article) without touching the identifier itself. */
export function normalizeSubject(raw: string): string {
  let s = raw.trim()
  // Peel quotes and punctuation in a loop, not in a fixed order: a subject arrives as `` `foldPath`, `` about as often as `` `foldPath` ``, and a single quote-then-punctuation pass leaves the backtick attached, so the identifier never resolves.
  for (;;) {
    const next = s.replace(/^[`'"]+/, '').replace(/[`'".,;:!]+$/, '').trim()
    if (next === s) break
    s = next
  }
  s = s.replace(/^(?:the|a|an) /i, '')
  return s.trim()
}

export type ResolvedSubject =
  | { kind: 'symbol'; name: string; file: string }
  | { kind: 'file'; path: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'symbol-only'; name: string; file: string }

/**
 * Which table the subject is looked up in first, and whether the other one is allowed at all.
 *
 * `symbol-first` -- `where`/`callers`/`impact`: these ask about a definition, so a symbol wins and a
 * file is the fallback (the router then refuses, naming `outline`).
 * `file-first` -- `tests`: `what tests cover config` means the file, `what tests cover foldPath` means
 * the symbol, and both have to work, so the file interpretation leads and the symbol backs it up.
 * `file-only` -- `exports`/`imports`: these are module-level properties, and a symbol subject is a
 * category error rather than a thing to redirect. Resolving them symbol-first is what made
 * `Check config exports` answer about src/bridges/openclaw_install.ts, because a same-named symbol
 * sorted first and the intent then followed it to ITS defining file: measured over the 32 distinct
 * subjects the captured corpus uses with this shape, 12 of the 14 that resolved were wrong.
 */
export type SubjectMode = 'symbol-first' | 'file-first' | 'file-only'

/** Page size for the scan in {@link resolveSymbolHit}. Not a cap: the scan pages until it finds a hit or the index runs out. */
const SYMBOL_SCAN_PAGE = 200

/**
 * One indexed symbol with this exact name in this project, never one in a vendored, generated, or
 * tool-metadata tree.
 *
 * Deliberately paged rather than filtered from a single capped query. Ignored trees sort FIRST under
 * `querySymbols`'s `ORDER BY file_path` -- `node_modules/` and `.git/` both come before `src/` -- so
 * they are exactly the rows that fill the front of any page, and a fixed cap followed by a filter
 * would report "no such symbol" for a symbol that is plainly there. That is not hypothetical: this
 * project's index holds 147 rows named `constructor` under `node_modules/` from six files alone.
 * Paging until a hit or exhaustion has no such blind spot, and costs one extra query only when a
 * project really has that much vendored code indexed.
 */
function resolveSymbolHit(subject: string, rootDir: string): { name: string; file: string } | null {
  for (let offset = 0; ; offset += SYMBOL_SCAN_PAGE) {
    const rows = querySymbols({ name: subject, rootDir, limit: SYMBOL_SCAN_PAGE, offset })
    if (rows.length === 0) return null
    const hit = rows.find((r) => !isIgnoredIndexPath(r.filePath))
    if (hit) return { name: hit.name, file: hit.filePath }
    if (rows.length < SYMBOL_SCAN_PAGE) return null
  }
}

/**
 * The subject read as a file: an exact path, else the project's file list matched by basename
 * ("config.ts") or by extensionless stem ("config"). Several matches is reported as ambiguity rather
 * than resolved by picking one, which would be a confident wrong answer.
 *
 * The match runs over the `files` table rather than over symbol rows: `files` is the authoritative
 * list of what is indexed (a file with no extracted symbols has no symbol rows at all), it needs one
 * query instead of a capped path-suffix scan, and it makes the candidate set independent of how many
 * symbols each file happens to contain.
 */
function resolveFileHit(subject: string, rootDir: string): ResolvedSubject | null {
  const entry = getFileEntry(resolveIndexPath(subject))
  if (entry && !isIgnoredIndexPath(entry.filePath)) return { kind: 'file', path: entry.filePath }
  if (subject.includes('/') || subject.includes('\\')) return null

  const want = foldPath(subject)
  const matches: string[] = []
  for (const [folded, indexed] of getProjectFileEntries(rootDir)) {
    if (isIgnoredIndexPath(folded)) continue
    const base = folded.slice(Math.max(folded.lastIndexOf('/'), folded.lastIndexOf('\\')) + 1)
    const dot = base.lastIndexOf('.')
    if (base === want || (dot > 0 && base.slice(0, dot) === want)) matches.push(indexed.filePath)
  }
  const paths = [...new Set(matches)].sort()
  if (paths.length === 0) return null
  if (paths.length === 1 && paths[0] !== undefined) return { kind: 'file', path: paths[0] }
  return { kind: 'ambiguous', candidates: paths }
}

/**
 * Looks the subject up in the index, in the order `mode` prescribes. Returns null when the subject is
 * in neither table -- the router then refuses rather than falling back to a fuzzy or semantic match
 * and presenting it as fact. Vendored dependency trees are excluded on every path: this repo indexes
 * 6 files under node_modules, and unfiltered they answered "where is worker" with a pdfjs type
 * declaration and "who calls worker" with a line of pdf.mjs.
 */
export function resolveSubject(subject: string, mode: SubjectMode = 'symbol-first'): ResolvedSubject | null {
  // Every lookup is scoped to THIS project. The symbols table is machine-wide, so an unscoped name query answers from whichever project happens to sort first: asking this repo "where does normalizePath live" resolved to a JavaScript file in an unrelated website checkout, and "tests for runWorker" to a scratch repro script on another drive. Both were confident, both were wrong, and neither was visible to a test whose index only ever holds one project.
  const rootDir = resolveProjectRoot({ project: process.cwd() })

  // Split on the LAST `::` by index rather than a regex: a Windows drive-letter path makes a lazy leading group ambiguous, and the file side is the part that may legitimately contain a colon.
  const sep = subject.lastIndexOf('::')
  if (sep > 0 && sep + 2 < subject.length) {
    const file = resolveIndexPath(subject.slice(0, sep))
    const hit = querySymbols({ filePath: file, name: subject.slice(sep + 2), rootDir, limit: 1 })[0]
    if (hit && !isIgnoredIndexPath(hit.filePath)) return { kind: 'symbol', name: hit.name, file: hit.filePath }
    return null
  }

  if (/\s/.test(subject)) return null

  if (mode === 'symbol-first') {
    const hit = resolveSymbolHit(subject, rootDir)
    if (hit) return { kind: 'symbol', name: hit.name, file: hit.file }
    return resolveFileHit(subject, rootDir)
  }

  const file = resolveFileHit(subject, rootDir)
  if (file) return file

  const hit = resolveSymbolHit(subject, rootDir)
  if (!hit) return null
  // `file-only`: the subject names a symbol and nothing else, so say so and point at the command that does take a symbol, rather than silently answering about the symbol's defining file.
  return mode === 'file-first'
    ? { kind: 'symbol', name: hit.name, file: hit.file }
    : { kind: 'symbol-only', name: hit.name, file: hit.file }
}

/** Intents whose delegate takes a file path; a symbol subject resolves to its defining file. */
const FILE_INTENTS: ReadonlySet<AnswerIntent> = new Set<AnswerIntent>(['tests', 'exports', 'imports'])

/** Row cap the router puts on every symbol-intent delegate, so an answer stays smaller than the file it exists to save you from reading. Measured against this repo's own index: `callers normalizePath` (500+ refs) emits 24,274 bytes unbounded versus 21,091 for src/paths.ts itself, and 878 bytes at 20 rows; `impact` and `symbol` already default to 20 at the CLI, so this is the bound the whole router shares. Every `via:` line names the flag that reproduces the window it printed, and the delegate discloses whatever it withheld. */
export const ANSWER_DELEGATE_LIMIT = 20

/** See {@link SubjectMode}: `exports`/`imports` are module-level and take no symbol, `tests` accepts either with the file reading first, everything else is about a definition. */
function subjectModeFor(intent: AnswerIntent): SubjectMode {
  if (intent === 'exports' || intent === 'imports') return 'file-only'
  return intent === 'tests' ? 'file-first' : 'symbol-first'
}

export function runAnswer(opts: AnswerOptions): number {
  const question = opts.question.trim()
  if (question.length === 0) {
    emitErr(refusal('the question is empty', 'token-goat answer "who calls <symbol>"'))
    return 1
  }

  if (isJudgementQuestion(question)) {
    emitErr(
      refusal(
        'that asks for judgement, intent, or runtime behaviour, which the index cannot answer -- it would need the code read and reasoned over',
        `token-goat semantic "${question}"`,
      ),
    )
    return 1
  }

  const cls = classify(question)
  if (cls === null) {
    emitErr(
      refusal(
        'no intent matched -- this router only answers where/who-calls/what-tests-cover/what-exports/what-imports/what-breaks questions about a named symbol or file',
        `token-goat semantic "${question}"`,
      ),
    )
    return 1
  }

  const resolved = resolveSubject(cls.subject, subjectModeFor(cls.intent))
  if (resolved === null) {
    emitErr(
      refusal(
        `'${cls.subject}' is not an indexed symbol or file`,
        `token-goat semantic "${question}"`,
      ),
    )
    return 1
  }

  const rootDir = resolveProjectRoot({ project: process.cwd() })

  if (resolved.kind === 'ambiguous') {
    const shown = resolved.candidates.slice(0, 5).map((c) => toDisplayPath(rootDir, c))
    const more = resolved.candidates.length - shown.length
    const first = shown[0] ?? ''
    // A symbol intent that got here fell through to the file reading, so re-asking it with one of these paths would refuse again for being a file: point at `outline` instead.
    const next = FILE_INTENTS.has(cls.intent)
      ? `token-goat answer "${cls.intent === 'tests' ? 'tests for' : cls.intent === 'imports' ? 'imports of' : 'exports of'} ${first}"`
      : `token-goat outline ${first}`
    emitErr(
      refusal(
        `'${cls.subject}' names ${resolved.candidates.length} files in this project (${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})`,
        next,
      ),
    )
    return 1
  }

  if (resolved.kind === 'symbol-only') {
    emitErr(
      refusal(
        `'${cls.subject}' is a symbol; exports/imports are file-level`,
        `token-goat ${cls.intent} ${toDisplayPath(rootDir, resolved.file)}`,
      ),
    )
    return 1
  }

  if (FILE_INTENTS.has(cls.intent)) {
    const file = resolved.kind === 'symbol' ? resolved.file : resolved.path
    const display = toDisplayPath(rootDir, file)
    if (cls.intent === 'tests') {
      emit(`via: token-goat test-for ${display}`)
      return runTestFor({ file })
    }
    if (cls.intent === 'exports') {
      emit(`via: token-goat exports ${display}`)
      return runExports({ file })
    }
    emit(`via: token-goat imports ${display}`)
    return runImports({ file })
  }

  if (resolved.kind === 'file') {
    const display = toDisplayPath(rootDir, resolved.path)
    emitErr(
      refusal(
        `'${cls.subject}' is a file, and ${cls.intent === 'where' ? 'where' : cls.intent} needs a symbol`,
        `token-goat outline ${display}`,
      ),
    )
    return 1
  }

  if (cls.intent === 'callers') {
    emit(`via: token-goat callers ${displaySafeText(resolved.name)} --limit ${ANSWER_DELEGATE_LIMIT}`)
    return runCallers({ symbol: resolved.name, limit: ANSWER_DELEGATE_LIMIT })
  }
  if (cls.intent === 'impact') {
    emit(`via: token-goat impact ${displaySafeText(resolved.name)} --top ${ANSWER_DELEGATE_LIMIT}`)
    return runImpact({ symbol: resolved.name, top: ANSWER_DELEGATE_LIMIT })
  }

  // `-p` is not decoration: `symbol` searches the machine-wide index unless the project scope is opted into, while the router always scopes to this project. Without it the pointer named a command whose output includes same-named definitions from every other checkout on the machine -- a `via:` line that does not reproduce its own window is worse than none, since the reader verifies against it and concludes the answer dropped rows.
  emit(`via: token-goat symbol ${displaySafeText(resolved.name)} -p --exclude-vendored`)
  const r = runSymbol({ name: resolved.name, projectRoot: rootDir, limit: ANSWER_DELEGATE_LIMIT, excludeVendored: true })
  if (r.text.length > 0) emit(r.text)
  return r.code
}

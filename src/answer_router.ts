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

import { getFileEntry, querySymbols } from './index_reader.js'
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

  { intent: 'impact', re: /^what breaks if (.+) changes?$/i },
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
  return collapsed.replace(/^(?:check|show|list|find|get|print|inspect) /i, '')
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

/** Bound on the basename scan below. A basename match is a path-suffix query, so an unbounded one on a large index scans every symbol row of every matching file to learn a fact about the file set. */
const BASENAME_SCAN_LIMIT = 500

/**
 * Looks the subject up in the index. A symbol wins over a file when both match, because every intent
 * that takes a file can reach it from the symbol's own definition site, while the reverse is not
 * true. Returns null when the subject is in neither table -- the router then refuses rather than
 * falling back to a fuzzy or semantic match and presenting it as fact.
 */
export function resolveSubject(subject: string): ResolvedSubject | null {
  // Every lookup is scoped to THIS project. The symbols table is machine-wide, so an unscoped name query answers from whichever project happens to sort first: asking this repo "where does normalizePath live" resolved to a JavaScript file in an unrelated website checkout, and "tests for runWorker" to a scratch repro script on another drive. Both were confident, both were wrong, and neither was visible to a test whose index only ever holds one project.
  const rootDir = resolveProjectRoot({ project: process.cwd() })

  // Split on the LAST `::` by index rather than a regex: a Windows drive-letter path makes a lazy leading group ambiguous, and the file side is the part that may legitimately contain a colon.
  const sep = subject.lastIndexOf('::')
  if (sep > 0 && sep + 2 < subject.length) {
    const file = resolveIndexPath(subject.slice(0, sep))
    const hit = querySymbols({ filePath: file, name: subject.slice(sep + 2), rootDir, limit: 1 })[0]
    if (hit) return { kind: 'symbol', name: hit.name, file: hit.filePath }
    return null
  }

  if (!/\s/.test(subject)) {
    const hit = querySymbols({ name: subject, rootDir, limit: 1 })[0]
    if (hit) return { kind: 'symbol', name: hit.name, file: hit.filePath }
    const entry = getFileEntry(resolveIndexPath(subject))
    if (entry) return { kind: 'file', path: entry.filePath }
    // A bare basename ("base.ts") is not resolvable against cwd, but the index can still name it -- as long as exactly one file in this project carries it. Several is reported as ambiguity rather than resolved by picking one, which would be a confident wrong answer.
    if (!subject.includes('/') && !subject.includes('\\') && subject.includes('.')) {
      const rows = querySymbols({ fileBaseName: subject, rootDir, limit: BASENAME_SCAN_LIMIT })
      const files = [...new Set(rows.map((r) => r.filePath))]
      if (files.length === 1 && files[0] !== undefined) return { kind: 'file', path: files[0] }
      if (files.length > 1) return { kind: 'ambiguous', candidates: files }
    }
  }
  return null
}

/** Intents whose delegate takes a file path; a symbol subject resolves to its defining file. */
const FILE_INTENTS: ReadonlySet<AnswerIntent> = new Set<AnswerIntent>(['tests', 'exports', 'imports'])

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

  const resolved = resolveSubject(cls.subject)
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
    emitErr(
      refusal(
        `'${cls.subject}' names ${resolved.candidates.length} files in this project (${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})`,
        `token-goat answer "${cls.intent === 'tests' ? 'tests for' : cls.intent === 'imports' ? 'imports of' : 'exports of'} ${shown[0] ?? ''}"`,
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
    emit(`via: token-goat callers ${displaySafeText(resolved.name)}`)
    return runCallers({ symbol: resolved.name })
  }
  if (cls.intent === 'impact') {
    emit(`via: token-goat impact ${displaySafeText(resolved.name)}`)
    return runImpact({ symbol: resolved.name })
  }

  emit(`via: token-goat symbol ${displaySafeText(resolved.name)}`)
  const r = runSymbol({ name: resolved.name, projectRoot: rootDir, limit: 20 })
  if (r.text.length > 0) emit(r.text)
  return r.code
}

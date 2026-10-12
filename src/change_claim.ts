/** Whether a subagent's final report claims a change of its own. Read by the evidence receipt and by the subagent-stop warning, both in agent_receipt.ts, so the two cannot disagree about what an accusation rests on. */

const CHANGE_VERBS = 'fixed|implemented|added|created|wrote|written|refactored|updated|changed|edited|modified|deleted|removed|patched|resolved|replaced|improved|applied|renamed|rewrote|rewritten'

/** Verbs a line may open with ("Fixed the parser bug."): the narrower list, because a bare opener has no pronoun to say who did it. */
const OPENER_VERBS = 'fixed|implemented|added|created|wrote|refactored|updated|changed|edited|modified|deleted|removed|patched|replaced|renamed|rewrote'

/** Objects that make a change verb a write-up or a thought, not an edit: "I wrote a report", "I changed my mind", "I added that this is read-only", "Added the following findings:". */
const NOT_AN_EDIT_OBJECT = '(?![ \\t]+(?:(?:the|a|an|my|our|this|these|some)[ \\t]+)?(?:summary|report|review|analysis|findings?|notes?|plan|mind|understanding|that|following)\\b)'

/** A fence closes only on its own marker, so a backtick fence holding `~~~` (or the reverse) does not end early. An unterminated one runs to the end. */
const FENCED_BLOCK_RE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g

/** Quoted material and code: blockquote lines, and lines indented four spaces or a tab that are not a nested list item. */
const QUOTED_LINE_RE = /^(?:[ \t]*>.*|(?: {4}|\t)(?![ \t]*(?:[-*•]|\d+[.)])[ \t]).*)$/gm

/** Evidence the text quotes a diff: a `+ ` line, a hunk header, or `diff --git`. Without it a `- ` line is a list item, the commonest shape of a report. */
const DIFF_EVIDENCE_RE = /^[ \t]*(?:\+[ \t]|@@|diff --git)/m

/** Lines of a quoted diff (`- removed foo`, `+ added bar`, `@@ -1 +1 @@`). */
const DIFF_LINE_RE = /^[ \t]*(?:[+-][ \t]|@@).*$/gm

/** First person, a change verb, and an object that is not a negation or a write-up: "I renamed foo to bar", "we fixed the parser", "I've also added a guard", "I made some edits". "I did not fix" and "I couldn't update" put a word between the pronoun and the verb and never match; "we updated nothing" and "I removed none" match the verb and are voided by the object; "if I fixed this" and "whether I fixed it" are conditions, not reports. */
const FIRST_PERSON_CLAIM_RE = new RegExp(
  `(?<!\\b(?:if|whether|when|unless|should|would|could)[ \\t]+)\\b(?:I|we)(?:['’]ve|[ \\t]+have)?[ \\t]+(?:(?:also|then|just|now|already|both)[ \\t]+)*(?:(?:${CHANGE_VERBS})\\b(?![ \\t]+up\\b)(?![ \\t]*(?::[ \\t]*)?(?:nothing|none|anything|no|not|neither)\\b)${NOT_AN_EDIT_OBJECT}|made[ \\t]+(?:(?:the|some|several|a[ \\t]+few|these|those|minor|small)[ \\t]+)*(?:changes?|edits?|modifications?|fixes|updates?)\\b)`,
  'i',
)

/** A line that opens with a change verb and names what was changed: an article or possessive, a backticked name, or a file name. "Fixed in v2 upstream", "Updated nothing" and "Renamed symbols are listed below." name nothing and stay quiet. */
const OPENER_CLAIM_RE = new RegExp(`^[ \\t]{0,3}(?:${OPENER_VERBS})${NOT_AN_EDIT_OBJECT}[ \\t]+(?:(?:the|a|an|this|these|my|our)[ \\t]|\`[^\`\\n]+\`|[\\w./-]+\\.[A-Za-z]{1,5}\\b)`, 'im')

/** An explicit header ("Changes made:", "## Changes", "Files changed:") with the text on its line and the list lines that follow it. Blank lines are removed before this runs. */
const CHANGES_HEADER_RE = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?[*_]*(?:changes(?: made)?|what (?:I|we) (?:changed|did)|files (?:changed|modified|edited))[*_]*[ \t]*(?::[*_]*[ \t]*|(?=\n))([^\n]*(?:\n[ \t]*(?:[-*•]|\d+[.)])[ \t]+[^\n]*)*)/i

/** A header followed by nothing: "none", "0", "(none)", "--". */
const NEGATED_LIST_RE = /^[([]?\s*(?:none|nothing|n\/a|na|no|not|zero|0|[-–—]+)\b|^[-–—]+\s*$/i

/** True when the report says the agent itself changed something: a first-person change claim, a line that opens with a change verb and its object, or a "Changes made:" style header over a list that is not negated. Prose that describes code ("the handler adds a header"), a bare "Fixed: nothing", quoted lines and quoted diffs are not claims. */
export function claimsOwnChange(report: string): boolean {
  const text = report.replace(FENCED_BLOCK_RE, '').replace(QUOTED_LINE_RE, '').replace(/\n[ \t]*(?=\n)/g, '')
  const header = CHANGES_HEADER_RE.exec(text)
  if (header !== null) {
    const listed = (header[1] ?? '').trim().replace(/^(?:[-*•]|\d+[.)])[ \t]*/, '')
    if (listed !== '' && !NEGATED_LIST_RE.test(listed)) return true
  }
  const looksLikeDiff = DIFF_EVIDENCE_RE.test(text)
  if (looksLikeDiff) return FIRST_PERSON_CLAIM_RE.test(text.replace(DIFF_LINE_RE, ''))
  return FIRST_PERSON_CLAIM_RE.test(text) || OPENER_CLAIM_RE.test(text)
}

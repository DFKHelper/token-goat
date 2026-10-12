/** Whether a subagent's final report claims a change of its own. Read by the evidence receipt and by the subagent-stop warning, both in agent_receipt.ts, so the two cannot disagree about what an accusation rests on. */

const CHANGE_VERBS = 'fixed|implemented|added|created|wrote|written|refactored|updated|changed|edited|modified|deleted|removed|patched|resolved|replaced|improved|applied|renamed|rewrote|rewritten'

/** Fenced blocks (an unterminated one runs to the end): quoted code and diffs are not the agent describing its work. */
const FENCED_BLOCK_RE = /(?:```|~~~)[\s\S]*?(?:```|~~~|$)/g

/** Lines of a quoted diff (`- removed foo`, `+ added bar`, `@@ -1 +1 @@`). Applied only after the header form has been read, because a header's own list items start the same way. */
const DIFF_LINE_RE = /^[ \t]*(?:[+-][ \t]|@@).*$/gm

/** First person, a change verb, and an object that is not a negation: "I renamed foo to bar", "we fixed the parser", "I've also added a guard". "I did not fix" and "I couldn't update" put a word between the pronoun and the verb and never match; "we updated nothing" and "I removed none" match the verb and are voided by the object. "I wrote up what I found" is a write-up, not a change. */
const FIRST_PERSON_CLAIM_RE = new RegExp(
  `\\b(?:I|we)(?:['’]ve|[ \\t]+have)?[ \\t]+(?:(?:also|then|just|now|already|both)[ \\t]+)*(?:${CHANGE_VERBS})\\b(?![ \\t]+up\\b)(?![ \\t]*(?::[ \\t]*)?(?:nothing|none|anything|no|not|neither)\\b)`,
  'i',
)

/** An explicit header ("Changes made:", "Files changed:") with the text on its line and the list lines that follow it. */
const CHANGES_HEADER_RE = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?[*_]*(?:changes(?: made)?|what (?:I|we) (?:changed|did)|files (?:changed|modified|edited))[*_]*[ \t]*:[*_]*[ \t]*([^\n]*(?:\n[ \t]*(?:[-*•]|\d+[.)])[ \t]+[^\n]*)*)/i

const NEGATED_LIST_RE = /^(?:none|nothing|n\/a|na|no|not|zero)\b/i

/** True when the report says the agent itself changed something: a first-person change claim, or a "Changes made:" style header over a list that is not negated. Prose that describes code ("the handler adds a header"), a bare "Fixed: nothing", and quoted diff lines are not claims. */
export function claimsOwnChange(report: string): boolean {
  const text = report.replace(FENCED_BLOCK_RE, '')
  const header = CHANGES_HEADER_RE.exec(text)
  if (header !== null) {
    const listed = (header[1] ?? '').trim().replace(/^(?:[-*•]|\d+[.)])[ \t]*/, '')
    if (listed !== '' && !NEGATED_LIST_RE.test(listed)) return true
  }
  return FIRST_PERSON_CLAIM_RE.test(text.replace(DIFF_LINE_RE, ''))
}

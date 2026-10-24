// Role extraction for the architecture map: the first doc-comment sentence of a module, capped at 120 code points. Ported from the arch-doc-sync skill's reference engine (sync_arch_docs.py, section "prose.mts"); SKILL.md "Component Table Contract" is the contract.

export const ROLE_MAX_CHARS = 120

const STRUCTURAL_LINE = /^(?:@|[-*+]\s|[0-9]+[.)]\s|#|={3,}|-{3,}|_{3,}|\*{3,})/
const NOT_PROSE = /<[A-Za-z/!]|--!?>|[{}]|=>|[=\-*#_~]{3,}/
const FILE_TAG = /^\s*@(?:fileoverview|file|overview)(?=\s|$)\s*/i
const CONTINUES = /[.!?:,;]$|\b(?:a|an|and|as|at|by|for|from|in|into|of|on|or|the|to|via|with)$/i
const DIRECTIVE = /^(['"])use [A-Za-z ]+\1\s*;?/
const WS_RUN = /\s+/g
const SENTENCE_END =
  /(?<!(?<![A-Za-z0-9_])[eE]\.[gG])(?<!(?<![A-Za-z0-9_])[iI]\.[eE])(?<!(?<![A-Za-z0-9_])[eE][tT][cC])(?<!(?<![A-Za-z0-9_])[vV][sS])(?<!(?<![A-Za-z0-9_])[cC][fF])\.(?=\s|$)/
const JSDOC_LINE_PREFIX = /^\s*\*(?:\s|$)?/
const DEFAULT_EXPORT = /(?:^|[\s;])export\s+default(?![A-Za-z0-9_])/
const TRUNCATED_TAIL_CHAR = /^[\s.,;:!?([{\u2013\u2014-]$/
const MARK = /^\p{M}$/u
const UPPERCASE_LETTER = /^\p{Lu}/u

const isMark = (ch) => MARK.test(ch)

/** The template role of a module nobody described: `<Layer> module: <basename>`. */
export function templateRole(key, layer) {
  return `${layer} module: ${key.slice(key.lastIndexOf('/') + 1)}`
}

function unclosedParens(cps) {
  const open = []
  cps.forEach((ch, i) => {
    if (ch === '(') open.push(i)
    else if (ch === ')' && open.length > 0) open.pop()
  })
  return open
}

function beforeUnclosedParen(cps) {
  const open = unclosedParens(cps)
  return open.length > 0 ? cps.slice(0, open[0]) : cps
}

function withoutUnclosedParens(cps) {
  const dropped = new Set()
  for (const at of unclosedParens(cps)) {
    dropped.add(at)
    let i = at + 1
    while (i < cps.length && isMark(cps[i])) dropped.add(i++)
  }
  return cps.filter((_, i) => !dropped.has(i))
}

function trimTruncatedTail(cps) {
  let end = cps.length
  for (;;) {
    let base = end
    while (base > 0 && isMark(cps[base - 1])) base--
    if (base === 0 || !TRUNCATED_TAIL_CHAR.test(cps[base - 1])) return cps.slice(0, end)
    end = base - 1
  }
}

function trimLeadingSpacesAndMarks(cps) {
  let start = 0
  while (start < cps.length && (cps[start] === ' ' || isMark(cps[start]))) start++
  return cps.slice(start)
}

function hardCutLength(cps) {
  let kept = ROLE_MAX_CHARS
  while (kept > 0 && kept < cps.length && isMark(cps[kept])) kept--
  return kept === 0 ? ROLE_MAX_CHARS : kept
}

/** At most 120 code points: the word-boundary cut first, then the hard cut, each tried before an unclosed `(`; no ellipsis. */
export function capRole(sentence) {
  const cps = Array.from(sentence)
  if (cps.length <= ROLE_MAX_CHARS) return sentence
  const kept = hardCutLength(cps)
  const head = cps.slice(0, kept)
  const space = cps[kept] === ' ' ? head.length : head.lastIndexOf(' ')
  const cuts = space > 0 ? [head.slice(0, space), head] : [head]
  for (const cut of cuts) {
    for (const candidate of [beforeUnclosedParen(cut), withoutUnclosedParens(cut)]) {
      const trimmed = trimLeadingSpacesAndMarks(trimTruncatedTail(candidate))
      if (trimmed.length > 0) return trimmed.join('')
    }
  }
  return head.join('').trimEnd()
}

/** First sentence of the summary paragraph, or null when there is none or it is not prose. */
export function docSentence(lines) {
  const paragraph = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (STRUCTURAL_LINE.test(line)) break
    if (paragraph.length > 0 && !CONTINUES.test(paragraph[paragraph.length - 1]) && UPPERCASE_LETTER.test(line)) break
    paragraph.push(line)
  }
  const collapsed = paragraph.join(' ').replace(WS_RUN, ' ')
  const cut = SENTENCE_END.exec(collapsed)
  const sentence = (cut === null ? collapsed : collapsed.slice(0, cut.index)).trim()
  if (sentence === '' || sentence.endsWith(':') || NOT_PROSE.test(sentence)) return null
  return capRole(sentence)
}

function nextLineStart(text, start) {
  const newline = text.indexOf('\n', start)
  return newline === -1 ? text.length : newline + 1
}

/** Bodies of the `/** *\/` blocks before the first statement (after a BOM, shebang, comments and directives). */
function leadingJsdocBlocks(text) {
  const blocks = []
  let i = text.startsWith('﻿') ? 1 : 0
  if (text.startsWith('#!', i)) i = nextLineStart(text, i)
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (text.startsWith('//', i)) {
      i = nextLineStart(text, i)
      continue
    }
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2)
      if (close === -1) return blocks
      if (text.startsWith('/**', i) && close > i + 2) blocks.push(text.slice(i + 3, close))
      i = close + 2
      continue
    }
    const directive = DIRECTIVE.exec(text.slice(i, i + 200))
    if (directive === null) return blocks
    i += directive[0].length
  }
}

function defaultExportJsdoc(text) {
  const exported = DEFAULT_EXPORT.exec(text)
  if (exported === null) return null
  const before = text.slice(0, exported.index + exported[0].indexOf('export')).trimEnd()
  if (!before.endsWith('*/')) return null
  const open = before.lastIndexOf('/**')
  const close = before.length - 2
  if (open === -1 || close <= open + 2 || before.slice(open + 3, close).includes('*/')) return null
  return before.slice(open + 3, close)
}

function jsDocLines(block) {
  const lines = block.split(/\r?\n/).map((line) => line.replace(JSDOC_LINE_PREFIX, ''))
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first !== -1 && FILE_TAG.test(lines[first])) lines[first] = lines[first].replace(FILE_TAG, '')
  return lines
}

/** The role sentence of a JS or TS module: its first leading doc comment that holds prose, else the one on `export default`. */
export function jsDocSentence(text) {
  const fallback = defaultExportJsdoc(text)
  for (const block of [...leadingJsdocBlocks(text), ...(fallback === null ? [] : [fallback])]) {
    const sentence = docSentence(jsDocLines(block))
    if (sentence !== null) return sentence
  }
  return null
}

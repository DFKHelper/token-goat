import { redactSecrets } from './secret_redact.js'
import { fenceFileText } from './untrusted_fence.js'

/** Near-miss search for an Edit whose `old_string` is not in the file. The model's copy of the text usually differs from the disk by something invisible in a transcript (trailing blanks, a curly quote, a dash, a non-breaking space, a re-indented block), so the diagnostic that names the exact on-disk lines saves the read-and-retry round trip. findNearMiss is pure; the caller owns the file read and its size cap, and describeNearMiss owns the redaction, caps and fencing of what is printed. */

/** The three ladders, in the order they are tried. A later rung is only reached when every earlier one found nothing. */
export type NearMissRung = 'trailing-whitespace' | 'unicode-punctuation' | 'indentation'

/** One place `old_string` matches once the rung's normalization is applied. Lines are 1-based and inclusive, offsets index the original text (`end` is exclusive and stops before the last line's terminator). */
export interface NearMissHit {
  startLine: number
  endLine: number
  start: number
  end: number
}

export interface NearMiss {
  rung: NearMissRung
  /** At most {@link MAX_HITS}; `truncated` says whether more existed. */
  hits: NearMissHit[]
  truncated: boolean
}

/** Hits kept per rung. The caller only names five line numbers, so a search that keeps going past this is spending time on text it will not print. */
const MAX_HITS = 20

/** Folded to the ASCII character a model would have typed: curly and low/high-reversed quotes, the dash family, and the minus sign. NFKC already turns NBSP, U+202F and the ellipsis character into plain space and `...`. */
const FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, '-'],
]

function foldPunctuation(line: string): string {
  let out = line.normalize('NFKC')
  for (const [pattern, replacement] of FOLDS) out = out.replace(pattern, replacement)
  return out
}

function trimEndBlanks(line: string): string {
  return line.replace(/[ \t\r\f\v]+$/, '')
}

const RUNGS: ReadonlyArray<{ rung: NearMissRung; normalize: (line: string) => string }> = [
  { rung: 'trailing-whitespace', normalize: trimEndBlanks },
  { rung: 'unicode-punctuation', normalize: (line) => trimEndBlanks(foldPunctuation(line)) },
  { rung: 'indentation', normalize: (line) => foldPunctuation(line).trim() },
]

interface FileLine {
  text: string
  start: number
  end: number
}

function splitLines(text: string): FileLine[] {
  const lines: FileLine[] = []
  let start = 0
  while (start <= text.length) {
    const nl = text.indexOf('\n', start)
    const end = nl === -1 ? text.length : nl
    lines.push({ text: text.slice(start, end), start, end })
    if (nl === -1) break
    start = nl + 1
  }
  return lines
}

/** Whether the run of normalized file lines starting at `at` carries the normalized old lines. The first old line may begin mid-line and the last may stop mid-line (an `old_string` need not start or end on a line boundary), so those two compare by suffix and prefix; every line between must be equal. A one-line `old_string` compares by containment. `tailAnchored` is set when the last old line ended in blanks the normalization stripped: those blanks ended the model's text, so the file line must end there too, or a stripped `foo  ` would be taken to match the start of `foo bar`. */
function matchesAt(fileLines: readonly string[], oldLines: readonly string[], at: number, tailAnchored: boolean): boolean {
  const last = oldLines.length - 1
  if (last === 0) {
    const line = fileLines[at] as string
    return tailAnchored ? line.endsWith(oldLines[0] as string) : line.includes(oldLines[0] as string)
  }
  if (!(fileLines[at] as string).endsWith(oldLines[0] as string)) return false
  for (let i = 1; i < last; i++) {
    if (fileLines[at + i] !== oldLines[i]) return false
  }
  const tail = fileLines[at + last] as string
  return tailAnchored ? tail === oldLines[last] : tail.startsWith(oldLines[last] as string)
}

/** Find where `oldString` almost matches `fileText`. Returns null when it matches exactly (nothing to diagnose), when it is blank after normalization (it would match every blank line), or when no rung finds it. */
export function findNearMiss(fileText: string, oldString: string): NearMiss | null {
  if (oldString === '' || fileText.includes(oldString)) return null
  const lines = splitLines(fileText)
  const rawOld = oldString.split('\n')
  // A trailing newline in `old_string` names a whole last line, which the line-wise compare already treats as a full line.
  if (rawOld.length > 1 && rawOld[rawOld.length - 1] === '') rawOld.pop()
  if (rawOld.length > lines.length) return null
  for (const { rung, normalize } of RUNGS) {
    const oldLines = rawOld.map(normalize)
    const tailAnchored = /[ \t\r\f\v]$/.test(rawOld[rawOld.length - 1] as string)
    if (oldLines.every((line) => line === '')) return null
    const normalized = lines.map((line) => normalize(line.text))
    const hits: NearMissHit[] = []
    let truncated = false
    for (let at = 0; at + oldLines.length <= lines.length; at++) {
      if (!matchesAt(normalized, oldLines, at, tailAnchored)) continue
      if (hits.length === MAX_HITS) {
        truncated = true
        break
      }
      const first = lines[at] as FileLine
      const final = lines[at + oldLines.length - 1] as FileLine
      hits.push({ startLine: at + 1, endLine: at + oldLines.length, start: first.start, end: final.end })
    }
    if (hits.length > 0) return { rung, hits, truncated }
  }
  return null
}

/** What the rung forgave, in the words the diagnostic prints. */
export const NEAR_MISS_RUNG_NOTE: Readonly<Record<NearMissRung, string>> = {
  'trailing-whitespace': 'ignoring trailing whitespace',
  'unicode-punctuation': 'ignoring quote, dash and space-character differences',
  indentation: 'ignoring indentation',
}

/** Longest span printed back: past either bound the lines are named and the model views them, since a long copy costs about what the read it replaces would. */
export const MAX_SPAN_LINES = 20
export const MAX_SPAN_BYTES = 1536

/** Whether `text` is advice {@link describeNearMiss} produced, so a caller that only holds the string can log it under its own hint category. Pinned against every shape describeNearMiss emits by tests/edit_near_miss.test.ts. */
export function isNearMissAdvice(text: string): boolean {
  return /^\[token-goat\] Edit failed: string not found in [^\n]*?, but (?:line \d+ matches|lines \d+-\d+ match|\d+\+? places match),/.test(text)
}

/** The advice for a near miss, or null when `miss` has no hit. `display` is the already display-safe path. One hit under the caps returns the on-disk lines, redacted and then fenced as third-party file text; redaction runs before the caps so a secret cut by a cap cannot survive as a prefix, and the cap is measured on what would be printed. */
export function describeNearMiss(fileText: string, display: string, miss: NearMiss): string | null {
  const [only, ...rest] = miss.hits
  if (only === undefined) return null
  const note = NEAR_MISS_RUNG_NOTE[miss.rung]
  const head = `[token-goat] Edit failed: string not found in ${display}`
  if (rest.length > 0) {
    const where = miss.hits.slice(0, 5).map((hit) => (hit.startLine === hit.endLine ? `${hit.startLine}` : `${hit.startLine}-${hit.endLine}`))
    const count = `${miss.hits.length}${miss.truncated ? '+' : ''}`
    return `${head}, but ${count} places match, ${note} (lines ${where.join(', ')}). View one range and add surrounding context to old_string.`
  }
  const range = only.startLine === only.endLine ? `line ${only.startLine} matches` : `lines ${only.startLine}-${only.endLine} match`
  const span = redactSecrets(fileText.slice(only.start, only.end)).text
  if (only.endLine - only.startLine + 1 > MAX_SPAN_LINES || Buffer.byteLength(span, 'utf8') > MAX_SPAN_BYTES) {
    return `${head}, but ${range}, ${note}. View that range to copy the exact text.`
  }
  return `${head}, but ${range}, ${note}. Copy the on-disk text below into old_string exactly:\n${fenceFileText(span)}`
}

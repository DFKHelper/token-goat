export interface GrepScanLine {
  line: number
  text: string
}

export interface GrepScanHit extends GrepScanLine {
  context?: GrepScanLine[]
}

export interface GrepScanResult {
  hits: GrepScanHit[]
  totalCount: number
}

interface PendingContext {
  hit: GrepScanHit
  remaining: number
}

/**
 * Scan one file without materializing every split line or every hit.
 * The hit list is capped at the rows the caller can print; totalCount still
 * counts the complete search so truncation remains truthful.
 */
export function scanGrepText(text: string, regex: RegExp, maxHits: number, contextLines: number): GrepScanResult {
  const hitLimit = Math.max(0, Math.trunc(maxHits))
  const contextLimit = Math.max(0, Math.trunc(contextLines))
  const hits: GrepScanHit[] = []
  const preceding: GrepScanLine[] = []
  const pending: PendingContext[] = []
  let totalCount = 0
  let line = 0
  let start = 0

  // `start <= text.length` preserves String.split's final empty line after a
  // trailing newline, including the one-line result for an empty file.
  while (start <= text.length) {
    const newline = text.indexOf('\n', start)
    const rawEnd = newline === -1 ? text.length : newline
    const end = newline !== -1 && rawEnd > start && text.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd
    const current: GrepScanLine = { line: ++line, text: text.slice(start, end) }

    for (let i = pending.length - 1; i >= 0; i--) {
      const item = pending[i]
      if (item === undefined) continue
      item.hit.context?.push(current)
      item.remaining--
      if (item.remaining === 0) pending.splice(i, 1)
    }

    if (regex.global || regex.sticky) regex.lastIndex = 0
    if (regex.test(current.text)) {
      totalCount++
      if (hits.length < hitLimit) {
        const hit: GrepScanHit = { line: current.line, text: current.text }
        if (contextLimit > 0) {
          hit.context = [...preceding, current]
          pending.push({ hit, remaining: contextLimit })
        }
        hits.push(hit)
      }
    }

    if (contextLimit > 0 && hits.length < hitLimit) {
      preceding.push(current)
      if (preceding.length > contextLimit) preceding.shift()
    }

    if (newline === -1) break
    start = newline + 1
  }

  return { hits, totalCount }
}

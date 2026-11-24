function tokens(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
  return spaced.match(/[A-Za-z0-9]+/g)?.map((token) => token.toLowerCase()) ?? []
}

export function computeLexicalOverlapBoost(query: string, symbolName: string, signature: string, snippet: string): number {
  const queryTokens = [...new Set(tokens(query))]
  if (queryTokens.length === 0) return 0
  const nameTokens = new Set(tokens(symbolName))
  const allTokens = new Set([...nameTokens, ...tokens(signature), ...tokens(snippet)])
  const nameCoverage = queryTokens.filter((token) => nameTokens.has(token)).length / queryTokens.length
  const totalCoverage = queryTokens.filter((token) => allTokens.has(token)).length / queryTokens.length
  return Math.min(0.006, nameCoverage * 0.004 + totalCoverage * 0.002)
}

export function refineSemanticWindow(
  redactedBody: string,
  lineStart: number,
  query: string,
  maxWindowLines = 3,
): { text: string; windowStartLine: number; windowEndLine: number } {
  const lines = redactedBody.split('\n')
  const limit = Number.isInteger(maxWindowLines) && maxWindowLines > 0 ? maxWindowLines : 1
  if (lines.length <= limit) {
    return {
      text: redactedBody,
      windowStartLine: lineStart,
      windowEndLine: lineStart + Math.max(0, lines.length - 1),
    }
  }

  const queryTokens = new Set(tokens(query))
  const scores = lines.map((line) => {
    const lineTokens = tokens(line)
    if (lineTokens.length === 0) return 0
    return lineTokens.reduce((score, token) => score + (queryTokens.has(token) ? 1 : 0), 0) / lineTokens.length
  })
  let bestStart = 0
  let bestScore = Number.NEGATIVE_INFINITY
  for (let start = 0; start <= lines.length - limit; start++) {
    const score = scores.slice(start, start + limit).reduce((sum, value) => sum + value, 0)
    if (score > bestScore) {
      bestScore = score
      bestStart = start
    }
  }
  return {
    text: lines.slice(bestStart, bestStart + limit).join('\n'),
    windowStartLine: lineStart + bestStart,
    windowEndLine: lineStart + bestStart + limit - 1,
  }
}

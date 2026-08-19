// Pure parsing/formatting for the tokens-saved status bar, kept free of the vscode API so it can be unit-tested from the main repo's vitest suite.

export interface StatsDay {
  date: string
  events: number
  bytes_saved: number
  tokens_saved: number
}

export interface StatsJson {
  total_tokens_saved: number
  total_bytes_saved: number
  total_events: number
  window_days: number
  by_day: StatsDay[]
}

export interface SavingsBarContent {
  text: string
  tooltip: string
}

// `token-goat stats --json` returns an object shaped like StatsJson; a malformed or truncated response (partial write, wrong binary on PATH) parses as valid JSON but fails this shape check, so callers get null instead of silently rendering garbage numbers.
export function parseStatsJson(raw: string): StatsJson | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Record<string, unknown>
  if (typeof candidate['total_tokens_saved'] !== 'number') return null
  if (typeof candidate['window_days'] !== 'number') return null
  if (!Array.isArray(candidate['by_day'])) return null
  return candidate as unknown as StatsJson
}

// The ledger is day-keyed (by_day), not session-keyed -- there is no session grain to read here. This renders the full window_days total rather than mislabeling it as "this session".
export function formatSavingsBar(stats: StatsJson | null): SavingsBarContent {
  if (!stats) {
    return {
      text: '🐐 token-goat',
      tooltip: 'token-goat is ready. Run `token-goat stats` in a terminal to see savings once the ledger has events.',
    }
  }
  const tokens = stats.total_tokens_saved
  const days = stats.window_days
  if (tokens === 0) {
    return {
      text: '🐐 token-goat: 0 tokens saved',
      tooltip: `No net token savings recorded in the last ${days} day(s) yet.`,
    }
  }
  if (tokens < 0) {
    const magnitude = Math.abs(tokens).toLocaleString()
    return {
      text: `🐐 token-goat: -${magnitude} tokens (net loss, ${days}d)`,
      tooltip: `token-goat cost more tokens than it saved over the last ${days} day(s): a net loss of ${magnitude} tokens, from the local ledger (\`token-goat stats\`).`,
    }
  }
  const magnitude = tokens.toLocaleString()
  return {
    text: `🐐 token-goat: ${magnitude} tokens saved (${days}d)`,
    tooltip: `${magnitude} tokens saved over the last ${days} day(s), across all sources (reads, hints, bash, images, compression), from the local ledger (\`token-goat stats\`).`,
  }
}

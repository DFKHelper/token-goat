#!/usr/bin/env node
/** Weekly adoption numbers for token-goat: npm downloads, GitHub stars and GitHub forks, one row per ISO week (Monday to Sunday, UTC). The whole series is rebuilt from the public APIs on every run, so nothing is stored between runs and nothing is committed back: `.github/workflows/adoption.yml` prints the table to the job summary once a week. Usage: `node scripts/adoption-baseline.mjs [--json] [--since YYYY-MM-DD]`. It needs no token: GitHub answers the star history and the forks list without one. The job still sends its own token (GH_TOKEN or GITHUB_TOKEN) when it has one, for GitHub's higher rate limit. */
import { isMainModule } from './is-main-module.mjs'

export const PACKAGE = 'token-goat'
export const REPO = 'DFKHelper/token-goat'

const DAY_MS = 86_400_000
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** npm's range endpoint serves at most 18 months per request and clamps a longer one without saying so, zero-filling the days it dropped; a year per request stays well inside that. */
export const NPM_RANGE_DAYS = 365
/** GitHub's page-size maximum for the forks list. */
const PER_PAGE = 100
/** A runaway stop for the forks page loop: 40,000 entries, far past this repository. */
const MAX_PAGES = 400
/** The star history serves 30 weeks per page and 100 pages at most (docs.github.com/en/rest/activity/starring, "Get repository star history", read 2026-10-20). */
const HISTORY_PER_PAGE = 30
const HISTORY_MAX_PAGES = 100
const DAYS_PER_WEEK = 7

/** Milliseconds at 00:00 UTC of a `YYYY-MM-DD` day, rejecting anything that is not a real calendar day. */
export function dayMs(day) {
  const m = DAY_RE.exec(String(day))
  if (!m) throw new Error(`not a YYYY-MM-DD day: ${day}`)
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (isoDay(ms) !== day) throw new Error(`not a calendar day: ${day}`)
  return ms
}

/** The `YYYY-MM-DD` UTC day an instant falls on. */
export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The Monday (UTC) that starts the ISO week holding `day`. */
export function weekStart(day) {
  const ms = dayMs(day)
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7
  return isoDay(ms - sinceMonday * DAY_MS)
}

/** Inclusive `[start, end]` windows of at most `maxDays` days covering `start..end`, oldest first. */
export function rangeChunks(start, end, maxDays = NPM_RANGE_DAYS) {
  const last = dayMs(end)
  const chunks = []
  for (let from = dayMs(start); from <= last; from += maxDays * DAY_MS) {
    chunks.push({ start: isoDay(from), end: isoDay(Math.min(from + (maxDays - 1) * DAY_MS, last)) })
  }
  return chunks
}

/** One timestamp per star in a star-history page: each `days[i]` of an entry is the stars created on the UTC day `week + i*86400` seconds, `week` being a Sunday at 00:00. An entry that is not `{ week, total, days }` with an integer week, seven non-negative integer days and a total equal to their sum is refused by name, so a changed response shape never reads as no stars. */
export function starHistoryTimes(page) {
  return page.flatMap((entry, index) => {
    const days = entry?.days
    const bad = (why) => new Error(`star history entry ${index} ${JSON.stringify(entry)?.slice(0, 200)} is ${why}`)
    if (!Number.isInteger(entry?.week)) throw bad('missing an integer week')
    if (!Array.isArray(days) || days.length !== DAYS_PER_WEEK || !days.every((n) => Number.isInteger(n) && n >= 0)) throw bad(`missing ${DAYS_PER_WEEK} non-negative integer days`)
    if (!Number.isInteger(entry.total) || entry.total !== days.reduce((sum, n) => sum + n, 0)) throw bad('missing a total equal to the sum of its days')
    return days.flatMap((count, i) => Array.from({ length: count }, () => new Date(entry.week * 1000 + i * DAY_MS).toISOString()))
  })
}

/** Every `created_at` in a forks page, refused when absent so that a changed response shape never reads as no forks. */
export function forkTimes(page) {
  return page.map((entry) => {
    if (typeof entry?.created_at !== 'string') throw new Error('a fork has no created_at')
    return entry.created_at
  })
}

/** One row per ISO week from the week holding `start` to the week holding `end`, both days inclusive. `downloads` is npm's `[{ day, downloads }]`; days outside `start..end` are ignored, which is what keeps npm's zero-filled not-yet-counted days out. `days` is how many days of the week fall inside the window, and `partial` marks a week with fewer than seven. `stars` and `forks` are running totals at the end of each row's last counted day. */
export function weeklySeries({ downloads, starredAt, forkedAt, start, end }) {
  const first = dayMs(start)
  const last = dayMs(end)
  if (first > last) throw new Error(`start ${start} is after end ${end}`)
  const perDay = new Map()
  for (const { day, downloads: n } of downloads) perDay.set(day, (perDay.get(day) ?? 0) + n)
  const starMs = starredAt.map((t) => Date.parse(t))
  const forkMs = forkedAt.map((t) => Date.parse(t))
  const rows = []
  for (let monday = dayMs(weekStart(start)); monday <= last; monday += 7 * DAY_MS) {
    const from = Math.max(monday, first)
    const to = Math.min(monday + 6 * DAY_MS, last)
    let total = 0
    for (let d = from; d <= to; d += DAY_MS) total += perDay.get(isoDay(d)) ?? 0
    const days = (to - from) / DAY_MS + 1
    const cutoff = to + DAY_MS
    rows.push({
      week: isoDay(monday),
      days,
      partial: days < 7,
      downloads: total,
      stars: starMs.filter((t) => t < cutoff).length,
      forks: forkMs.filter((t) => t < cutoff).length,
    })
  }
  return rows
}

const number = (n) => n.toLocaleString('en-US')

/** The series as a Markdown table, newest week first, with the one caveat a reader needs about the star and fork columns. */
export function formatMarkdown({ rows, start, end, repoStars }) {
  const newest = rows.at(-1)
  const lines = [
    `## ${PACKAGE} adoption by week`,
    '',
    `npm downloads, GitHub stars and forks from ${start} to ${end} (UTC). Weeks start on Monday.`,
    '',
    '| Week of | npm downloads | Stars | Forks |',
    '|---|---:|---:|---:|',
  ]
  // The weeks before the first counted download are the months the repository existed and the package did not; a dash says that, where a 0 would read as nobody installing it.
  const firstCounted = rows.findIndex((row) => row.downloads > 0)
  const table = rows.map((row, i) => {
    const note = row.partial ? ` (${row.days} ${row.days === 1 ? 'day' : 'days'})` : ''
    const downloads = firstCounted === -1 || i < firstCounted ? '—' : number(row.downloads)
    return `| ${row.week} | ${downloads}${note} | ${number(row.stars)} | ${number(row.forks)} |`
  })
  lines.push(...table.reverse())
  const total = rows.reduce((sum, row) => sum + row.downloads, 0)
  lines.push(
    '',
    `At the end of ${end}: ${number(total)} downloads in all, ${number(newest?.stars ?? 0)} stars in GitHub's star history, ${number(newest?.forks ?? 0)} forks.${Number.isInteger(repoStars) ? ` GitHub reports ${number(repoStars)} stars for the repository now.` : ''}`,
    '',
    'A dash means npm had counted no downloads yet. Stars are the stars added per day as the GitHub star history reports them, and GitHub does not guarantee that its day boundaries are UTC, so a star made near midnight can land a day off. The closing line also gives the current star count of the repository, which GitHub measures separately. Forks count the ones that still exist: GitHub lists current forks with the date each was made, so a deleted fork drops out of every week, not only the week it happened. npm counts every download, including CI installs and mirrors, so read the downloads column as a trend rather than as a number of people.',
  )
  return `${lines.join('\n')}\n`
}

const MESSAGE_CHARS = 300
const DETAIL_HEADERS = ['x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'x-accepted-github-permissions']

/** What a refused response says: GitHub's `message` (or the start of a body that is not JSON) and the rate-limit and permission headers it sent. A body that cannot be read or parsed leaves `message` empty. */
async function refusalDetail(res) {
  const text = await res.text().catch(() => '')
  let message = text
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.message === 'string') message = parsed.message
  } catch {
    // Not JSON: the start of the raw text is the message.
  }
  message = message.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS)
  const headers = {}
  for (const name of DETAIL_HEADERS) {
    const value = res.headers?.get(name)
    if (value !== null && value !== undefined && value !== '') headers[name] = String(value)
  }
  return { message, headers }
}

async function getJson(url, headers, fetchImpl) {
  const res = await fetchImpl(url, { headers })
  if (!res.ok) {
    const { message, headers: seen } = await refusalDetail(res)
    // GitHub answers the stargazer list with 401 when no token is sent (checked 2026-09-29), so the set-a-token hint is given only when no Authorization header went out; a 401 after one means the token was rejected. A 403 or 429 is called rate limited only when x-ratelimit-remaining is 0, retry-after is present or the message names a rate limit, as GitHub's troubleshooting page describes.
    const limited = (res.status === 403 || res.status === 429) && (seen['x-ratelimit-remaining']?.trim() === '0' || 'retry-after' in seen || /rate limit/i.test(message))
    const unauthorized = res.status === 401 ? (headers.Authorization ? ' (the token was rejected)' : ' (GitHub needs a token for this: set GH_TOKEN, for example to the output of `gh auth token`)') : ''
    const hint = unauthorized || (limited ? ` (rate limited${headers.Authorization ? '' : ': set GH_TOKEN to raise the GitHub limit'})` : '')
    const resetDate = new Date(Number(seen['x-ratelimit-reset']) * 1000)
    const resetAt = limited && 'x-ratelimit-reset' in seen && !Number.isNaN(resetDate.getTime()) ? ` (resets at ${resetDate.toISOString()})` : ''
    const facts = [...(message ? [`message: ${message}`] : []), ...Object.entries(seen).map(([name, value]) => `${name}: ${value}`)]
    throw new Error(`GET ${url} returned HTTP ${res.status}${hint}${resetAt}${facts.length ? `; ${facts.join('; ')}` : ''}`)
  }
  return res.json()
}

/** Every entry of a paged GitHub list, page 1 onward until a page comes back short. `spec` is `{ listPath, params, extract, perPage, maxPages, overflow }`; a full last allowed page throws `overflow` instead of returning a truncated list. */
async function githubList({ listPath, params, extract, perPage, maxPages, overflow }, headers, fetchImpl) {
  const out = []
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`https://api.github.com/${listPath}`)
    for (const [key, value] of Object.entries({ ...params, per_page: perPage, page })) url.searchParams.set(key, String(value))
    const batch = await getJson(url.href, headers, fetchImpl)
    if (!Array.isArray(batch)) throw new Error(`${listPath} did not return a list`)
    out.push(...extract(batch))
    if (batch.length < perPage) return out
  }
  throw new Error(overflow)
}

/** Fetch everything and build the series. `since` defaults to the day the repository was created. `end` is the last day npm has counted, read from its own last-day endpoint: the range endpoint zero-fills the day or two it has not counted yet, and those zeros would read as a collapse in the newest week. */
export async function collect({ since, env = process.env, fetchImpl = fetch } = {}) {
  const token = env['GH_TOKEN'] || env['GITHUB_TOKEN']
  const github = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${PACKAGE}-adoption-baseline`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  const repo = await getJson(`https://api.github.com/repos/${REPO}`, github, fetchImpl)
  const start = since ?? String(repo.created_at).slice(0, 10)
  const lastDay = await getJson(`https://api.npmjs.org/downloads/point/last-day/${PACKAGE}`, {}, fetchImpl)
  const end = lastDay.end
  dayMs(start)
  dayMs(end)
  const downloads = []
  for (const chunk of rangeChunks(start, end)) {
    const body = await getJson(`https://api.npmjs.org/downloads/range/${chunk.start}:${chunk.end}/${PACKAGE}`, {}, fetchImpl)
    if (!Array.isArray(body.downloads)) throw new Error(`npm range ${chunk.start}:${chunk.end} has no downloads list`)
    downloads.push(...body.downloads)
  }
  if (!Number.isInteger(repo.stargazers_count)) throw new Error(`${REPO} has no integer stargazers_count`)
  const historyPath = `repos/${REPO}/stargazers/history`
  const starredAt = await githubList({ listPath: historyPath, params: {}, extract: starHistoryTimes, perPage: HISTORY_PER_PAGE, maxPages: HISTORY_MAX_PAGES, overflow: `${historyPath} is longer than GitHub serves: page ${HISTORY_MAX_PAGES} of ${HISTORY_PER_PAGE} weeks is full, so the star history cannot be counted whole` }, github, fetchImpl)
  const forksPath = `repos/${REPO}/forks`
  const forkedAt = await githubList({ listPath: forksPath, params: { sort: 'oldest' }, extract: forkTimes, perPage: PER_PAGE, maxPages: MAX_PAGES, overflow: `${forksPath} ran past ${MAX_PAGES} pages` }, github, fetchImpl)
  return { start, end, repoStars: repo.stargazers_count, rows: weeklySeries({ downloads, starredAt, forkedAt, start, end }) }
}

async function main(argv) {
  const json = argv.includes('--json')
  const sinceAt = argv.indexOf('--since')
  const since = sinceAt === -1 ? undefined : argv[sinceAt + 1]
  if (sinceAt !== -1 && !since) throw new Error('--since needs a YYYY-MM-DD day')
  const report = await collect({ since })
  process.stdout.write(json ? `${JSON.stringify({ package: PACKAGE, repo: REPO, ...report }, null, 2)}\n` : formatMarkdown(report))
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`adoption-baseline: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}

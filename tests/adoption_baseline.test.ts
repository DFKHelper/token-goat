/** `scripts/adoption-baseline.mjs` rebuilds token-goat's weekly npm downloads, stars and forks from the public APIs, for the weekly `adoption.yml` job summary. Provenance: - `tests/fixtures/adoption/*.json` are CAPTURE: real responses fetched on 2026-09-29 from `api.npmjs.org/downloads/range/2026-06-25:2026-09-28/token-goat`, `api.npmjs.org/downloads/point/last-day/token-goat`, and the first page of `.../forks?sort=oldest` (cut to its first few entries and stripped to the one timestamp field the script reads, so no user login or id is committed). `tests/fixtures/adoption/star-history.json` is CAPTURE too: the whole first page of an unauthenticated `GET api.github.com/repos/DFKHelper/token-goat/stargazers/history?per_page=30&page=1`, HTTP 200 on 2026-10-20, 24 weeks, kept byte for byte. The range fixture keeps npm's zero-filled 2026-09-28, a day it had not counted yet when fetched: the last-day endpoint said 2026-09-27 at the same moment. - The repository's `created_at` (2026-05-16T00:31:24Z) is CAPTURE from `api.github.com/repos/DFKHelper/token-goat` on 2026-09-29, and its `stargazers_count` (143) is CAPTURE from the same endpoint on 2026-10-20. - The 401 status is CAPTURE: an unauthenticated GET of the stargazers list answered `401 Requires authentication` on 2026-09-29. - The star-history entry shape (`week`, `total`, `days`; days start on Sunday; at most 30 entries per page and 100 pages) is FORMAT-DERIVED from https://docs.github.com/en/rest/activity/starring "Get repository star history", read 2026-10-20; the padded and malformed entries below are HAND-DERIVED from that shape. - Week boundaries, sums and cumulative counts below are HAND-DERIVED from the fixture values and a calendar, not from the script. The real default `fetch` path runs against the live APIs in the dogfood run and in the weekly workflow; `collect` here gets an injected fetch that serves the captured bodies by URL. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { collect, dayMs, formatMarkdown, rangeChunks, starHistoryTimes, weeklySeries, weekStart } from '../scripts/adoption-baseline.mjs'

const FIXTURES = path.join(__dirname, 'fixtures', 'adoption')
const fixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as T

const range = fixture<{ downloads: Array<{ day: string; downloads: number }> }>('npm-range.json')
const lastDay = fixture<{ end: string }>('npm-last-day.json')
type HistoryWeek = { week: number; total: number; days: number[] }
const history = fixture<HistoryWeek[]>('star-history.json')
const forks = fixture<Array<{ created_at: string }>>('forks.json')
const REPO_META = { created_at: '2026-05-16T00:31:24Z', stargazers_count: 143 }
const HISTORY_PATH = '/repos/DFKHelper/token-goat/stargazers/history'
/** A valid page-sized run of weeks with no stars, to make a page the length GitHub serves. */
const zeroWeeks = (count: number, firstWeek = 1_700_000_000): HistoryWeek[] => Array.from({ length: count }, (_, i) => ({ week: firstWeek + i * 7 * 86_400, total: 0, days: [0, 0, 0, 0, 0, 0, 0] }))

type Served = { status?: number; body: unknown; responseHeaders?: Record<string, string> }
function fakeFetch(route: (url: URL) => Served) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const { status = 200, body, responseHeaders = {} } = route(new URL(url))
    const sent = new Map(Object.entries(responseHeaders).map(([name, value]) => [name.toLowerCase(), value]))
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
      headers: { get: (name: string) => sent.get(name.toLowerCase()) ?? null },
    })
  }
  return { calls, fetchImpl }
}

function capturedApis(url: URL): Served {
  if (url.pathname === '/repos/DFKHelper/token-goat') return { body: REPO_META }
  if (url.pathname === '/downloads/point/last-day/token-goat') return { body: lastDay }
  if (url.pathname.startsWith('/downloads/range/')) return { body: range }
  if (url.pathname === HISTORY_PATH) return { body: history }
  if (url.pathname === '/repos/DFKHelper/token-goat/forks') return { body: forks }
  throw new Error(`unexpected URL ${url.href}`)
}

describe('calendar helpers', () => {
  it('finds the ISO Monday of a week in UTC', () => {
    expect(weekStart('2026-06-25')).toBe('2026-06-22') // a Thursday
    expect(weekStart('2026-09-21')).toBe('2026-09-21') // a Monday
    expect(weekStart('2026-09-27')).toBe('2026-09-21') // a Sunday belongs to the week before it
    expect(weekStart('2027-01-01')).toBe('2026-12-28') // across a year end
  })

  it('refuses days that are not real calendar days', () => {
    expect(() => dayMs('2026-02-30')).toThrow('not a calendar day')
    expect(() => dayMs('2026-9-1')).toThrow('not a YYYY-MM-DD day')
  })

  it('splits a long range into inclusive chunks with no gap or overlap', () => {
    expect(rangeChunks('2026-01-01', '2026-01-10', 4)).toEqual([
      { start: '2026-01-01', end: '2026-01-04' },
      { start: '2026-01-05', end: '2026-01-08' },
      { start: '2026-01-09', end: '2026-01-10' },
    ])
    expect(rangeChunks('2026-05-16', '2026-09-27')).toEqual([{ start: '2026-05-16', end: '2026-09-27' }])
  })
})

describe('weeklySeries', () => {
  const rows = weeklySeries({ downloads: range.downloads, starredAt: starHistoryTimes(history), forkedAt: forks.map((f) => f.created_at), start: '2026-06-25', end: lastDay.end })

  it('starts on the Monday of the first day and marks the clipped first week partial', () => {
    expect(rows[0]).toMatchObject({ week: '2026-06-22', days: 4, partial: true, downloads: 87 + 493 + 742 + 264 })
    const sixDays = weeklySeries({ downloads: range.downloads, starredAt: [], forkedAt: [], start: '2026-09-22', end: '2026-09-27' })
    expect(sixDays).toEqual([{ week: '2026-09-21', days: 6, partial: true, downloads: 2182 - 243, stars: 0, forks: 0 }])
  })

  it('sums the newest full week and leaves out the zero-filled day npm had not counted', () => {
    expect(rows.at(-1)).toMatchObject({ week: '2026-09-21', days: 7, partial: false, downloads: 243 + 217 + 1073 + 246 + 256 + 51 + 96 })
    expect(rows.reduce((sum, row) => sum + row.downloads, 0)).toBe(15_726)
  })

  it('ignores a counted day past end, so a late-arriving day cannot land in the wrong week', () => {
    const late = weeklySeries({ downloads: [...range.downloads, { day: '2026-09-28', downloads: 999 }], starredAt: [], forkedAt: [], start: '2026-09-21', end: '2026-09-27' })
    expect(late).toHaveLength(1)
    expect(late[0]?.downloads).toBe(2182)
  })

  it('counts stars and forks as running totals at the end of each week', () => {
    const early = weeklySeries({ downloads: [], starredAt: starHistoryTimes(history), forkedAt: forks.map((f) => f.created_at), start: '2026-05-16', end: '2026-07-12' })
    const byWeek = Object.fromEntries(early.map((row) => [row.week, [row.stars, row.forks]]))
    expect(byWeek['2026-05-11']).toEqual([1, 1]) // the history week of Sun 05-17 holds [1, 3, ...]: 1 star on Sun 05-17, plus the 05-17 fork
    expect(byWeek['2026-05-18']).toEqual([4, 1]) // the 3 stars of Mon 05-18 are the only others that week: 1 + 3
    // Through Sun 06-14: history weeks 05-10..06-07 total 0+4+3+6+5 = 18, plus Sun 06-14's 3 = 21; ISO week 06-15..06-21 adds Mon..Sun 7+3+2+0+1+1+0 = 14, so 35; ISO week 06-22..06-28 adds only Sat 06-27's 1, so 36.
    expect(byWeek['2026-06-15']).toEqual([35, 3]) // forks of 06-15 and 06-16
    expect(byWeek['2026-06-22']?.[0]).toBe(36)
    expect(byWeek['2026-06-29']).toEqual([51, 4]) // stars 36 + Mon..Sun 1+1+1+2+1+0+9 = 15, the 9 being Sun 07-05; the 07-05 fork, a Sunday, falls in this week too
  })
})

describe('starHistoryTimes', () => {
  it('places each day of a week on the UTC day week + i days: a Sunday week start, then Monday', () => {
    // week 1792281600 is Sunday 2026-10-18 00:00 UTC (1792281600 = 20745 days * 86400); days [1, 1, 0, ...] are one star on Sun 10-18 and one on Mon 10-19.
    expect(starHistoryTimes([{ week: 1_792_281_600, total: 2, days: [1, 1, 0, 0, 0, 0, 0] }])).toEqual(['2026-10-18T00:00:00.000Z', '2026-10-19T00:00:00.000Z'])
  })

  it('counts every star of the captured page', () => {
    expect(starHistoryTimes(history)).toHaveLength(143) // HAND-DERIVED: the 24 captured totals sum to 143, the stargazers_count the repository reported the same day
  })

  it.each([
    ['a total that is not the sum of its days', { week: 1_792_281_600, total: 3, days: [1, 1, 0, 0, 0, 0, 0] }],
    ['a week that is not an integer', { week: '1792281600', total: 2, days: [1, 1, 0, 0, 0, 0, 0] }],
    ['six days', { week: 1_792_281_600, total: 2, days: [1, 1, 0, 0, 0, 0] }],
    ['a day that is not an integer', { week: 1_792_281_600, total: 2, days: [1, 1, 0, 0, 0, 0, 'x'] }],
    ['no days', { week: 1_792_281_600, total: 0 }],
    ['an entry that is not an object', null],
  ])('refuses %s and names the entry instead of counting it as zero', (_what, bad) => {
    expect(() => starHistoryTimes([...zeroWeeks(2), bad as HistoryWeek])).toThrow(/^star history entry 2 /)
  })
})

describe('formatMarkdown', () => {
  it('shows a dash for the weeks before the first download and states the totals as of end', () => {
    const rows = weeklySeries({ downloads: range.downloads, starredAt: starHistoryTimes(history), forkedAt: [], start: '2026-06-15', end: lastDay.end })
    const md = formatMarkdown({ rows, start: '2026-06-15', end: lastDay.end, repoStars: 143 })
    expect(md).toContain('| 2026-06-15 | — | 35 | 0 |')
    expect(md).toContain('| 2026-06-22 | 1,586 | 36 | 0 |')
    expect(md).toContain('| 2026-09-21 | 2,182 | 128 | 0 |') // HAND-DERIVED: 143 in all minus the stars after Sun 09-27 (Mon 09-28 1 + Thu 10-01 1 + week 10-04 10 + week 10-11 1 + week 10-18 2 = 15) = 128
    expect(md.indexOf('| 2026-09-21 |')).toBeLessThan(md.indexOf('| 2026-06-15 |'))
    expect(md).toContain("At the end of 2026-09-27: 15,726 downloads in all, 128 stars in GitHub's star history, 0 forks. GitHub reports 143 stars for the repository now.")
  })

  it('does not say stars still exist or that a token is needed, and states that GitHub day boundaries need not be UTC', () => {
    const md = formatMarkdown({ rows: weeklySeries({ downloads: [], starredAt: [], forkedAt: [], start: '2026-06-01', end: '2026-06-07' }), start: '2026-06-01', end: '2026-06-07' })
    expect(md).not.toContain('Stars and forks count the ones that still exist')
    expect(md).toContain("GitHub does not guarantee that its day boundaries are UTC")
    expect(md).not.toContain('GitHub reports')
  })

  it('says how many days a week clipped by the start holds', () => {
    const rows = weeklySeries({ downloads: range.downloads, starredAt: [], forkedAt: [], start: '2026-06-25', end: lastDay.end })
    expect(formatMarkdown({ rows, start: '2026-06-25', end: lastDay.end })).toContain('| 2026-06-22 | 1,586 (4 days) | 0 | 0 |')
  })

  it('keeps a real zero after the first download as 0, not a dash', () => {
    const rows = weeklySeries({ downloads: [{ day: '2026-06-01', downloads: 5 }], starredAt: [], forkedAt: [], start: '2026-06-01', end: '2026-06-14' })
    expect(formatMarkdown({ rows, start: '2026-06-01', end: '2026-06-14' })).toContain('| 2026-06-08 | 0 | 0 | 0 |')
  })
})

describe('collect', () => {
  it('builds the series from the captured responses, starting at the repository creation day', async () => {
    const { calls, fetchImpl } = fakeFetch(capturedApis)
    const report = await collect({ env: { GH_TOKEN: 'tok' }, fetchImpl })
    expect(report.start).toBe('2026-05-16')
    expect(report.end).toBe('2026-09-27')
    expect(report.rows.at(-1)).toMatchObject({ week: '2026-09-21', downloads: 2182, stars: 128, forks: 4 })
    expect(report.repoStars).toBe(143)
    expect(calls.map((c) => new URL(c.url).pathname)).toContain('/downloads/range/2026-05-16:2026-09-27/token-goat')
    const starCalls = calls.filter((c) => c.url.includes('/stargazers'))
    expect(starCalls.map((c) => new URL(c.url).pathname)).toEqual([HISTORY_PATH])
    expect(new URL(starCalls[0]?.url ?? '').searchParams.get('per_page')).toBe('30')
    expect(starCalls[0]?.headers).toMatchObject({ Accept: 'application/vnd.github+json', Authorization: 'Bearer tok' })
    expect(calls.find((c) => c.url.includes('/forks'))?.url).toContain('sort=oldest')
  })

  it('counts the captured history with no token at all, and the table shows both star numbers', async () => {
    const { calls, fetchImpl } = fakeFetch(capturedApis)
    const report = await collect({ env: {}, fetchImpl })
    expect(calls.every((c) => !('Authorization' in c.headers))).toBe(true)
    expect(report.rows.at(-1)?.stars).toBe(128)
    expect(formatMarkdown(report)).toContain("128 stars in GitHub's star history, 4 forks. GitHub reports 143 stars for the repository now.")
  })

  it('refuses a repository response without an integer stargazers_count instead of printing 0', async () => {
    const { fetchImpl } = fakeFetch((url) => (url.pathname === '/repos/DFKHelper/token-goat' ? { body: { created_at: REPO_META.created_at } } : capturedApis(url)))
    await expect(collect({ env: {}, fetchImpl })).rejects.toThrow('no integer stargazers_count')
  })

  const historyCalls = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.includes('/stargazers/history')).map((c) => new URL(c.url).searchParams.get('page'))

  it('stops at page 1 when it comes back short', async () => {
    const { calls, fetchImpl } = fakeFetch(capturedApis)
    const outcome = await collect({ env: {}, fetchImpl }).catch((e: Error) => e)
    expect(history).toHaveLength(24)
    expect(historyCalls(calls)).toEqual(['1'])
    expect(outcome).not.toBeInstanceOf(Error)
  })

  it('asks for page 2 only when page 1 holds 30 entries, and stops at the short page 2', async () => {
    const full = zeroWeeks(30)
    const { calls, fetchImpl } = fakeFetch((url) => (url.pathname === HISTORY_PATH ? { body: url.searchParams.get('page') === '1' ? full : history } : capturedApis(url)))
    const report = await collect({ env: {}, fetchImpl }).catch((e: Error) => e)
    expect(historyCalls(calls)).toEqual(['1', '2'])
    expect((report as { rows: Array<{ stars: number }> }).rows.at(-1)?.stars).toBe(128)
  })

  it('stops on an empty page after a full one', async () => {
    const { calls, fetchImpl } = fakeFetch((url) => (url.pathname === HISTORY_PATH ? { body: url.searchParams.get('page') === '1' ? zeroWeeks(30) : [] } : capturedApis(url)))
    const outcome = await collect({ env: {}, fetchImpl }).catch((e: Error) => e)
    expect(historyCalls(calls)).toEqual(['1', '2'])
    expect(outcome).not.toBeInstanceOf(Error)
  })

  it('fails with a too-long message when page 100 is full, and never asks for page 101', async () => {
    const { calls, fetchImpl } = fakeFetch((url) => (url.pathname === HISTORY_PATH ? { body: zeroWeeks(30) } : capturedApis(url)))
    await expect(collect({ env: {}, fetchImpl })).rejects.toThrow(/stargazers\/history is longer than GitHub serves: page 100 of 30 weeks is full/)
    const pages = historyCalls(calls)
    expect(pages).toHaveLength(100)
    expect(pages.at(-1)).toBe('100')
  })

  it('refuses a history page with a malformed entry and names it', async () => {
    const bad = { week: 1_792_281_600, total: 5, days: [1, 1, 0, 0, 0, 0, 0] }
    const { fetchImpl } = fakeFetch((url) => (url.pathname === HISTORY_PATH ? { body: [...history, bad] } : capturedApis(url)))
    await expect(collect({ env: {}, fetchImpl })).rejects.toThrow(/star history entry 24 .*"total":5.* is missing a total equal to the sum of its days/)
  })

  it('refuses a history response that is not a list', async () => {
    const { fetchImpl } = fakeFetch((url) => (url.pathname === HISTORY_PATH ? { body: { message: 'ok' } } : capturedApis(url)))
    await expect(collect({ env: {}, fetchImpl })).rejects.toThrow('stargazers/history did not return a list')
  })

  // The three rows below are FORMAT-DERIVED (the reset epoch 1792000000 is HAND-DERIVED: 2026-10-14T17:46:40Z computed by Date, not by the script) from GitHub's REST docs (read 2026-10-20): https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api says a primary rate limit answers 403 or 429 with x-ratelimit-remaining 0 and x-ratelimit-reset in UTC epoch seconds, and that "Resource not accessible by integration" is the error for a GitHub App token with insufficient permissions, with the permissions needed in X-Accepted-GitHub-Permissions; https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api lists the x-ratelimit-* headers.
  const refuseHistory = (served: Served) => fakeFetch((url) => (url.pathname === HISTORY_PATH ? served : capturedApis(url)))

  it('gives the server message and no rate-limit claim for a 403 that carries no rate-limit evidence', async () => {
    const { fetchImpl } = refuseHistory({ status: 403, body: { message: 'Resource not accessible by integration' }, responseHeaders: { 'x-accepted-github-permissions': 'metadata=read' } })
    const error = await collect({ env: { GH_TOKEN: 'ghs_secret_token' }, fetchImpl }).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    const text = (error as Error).message
    expect(text).toContain('HTTP 403')
    expect(text).toContain('Resource not accessible by integration')
    expect(text).toContain('x-accepted-github-permissions: metadata=read')
    expect(text).not.toContain('rate limited')
    expect(text).not.toContain('ghs_secret_token')
  })

  it('says rate limited and names the reset time when the remaining count is 0', async () => {
    const { fetchImpl } = refuseHistory({ status: 403, body: { message: 'API rate limit exceeded for user ID 1.' }, responseHeaders: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1792000000' } })
    await expect(collect({ env: { GH_TOKEN: 'tok' }, fetchImpl })).rejects.toThrow(/HTTP 403 \(rate limited\) \(resets at 2026-10-14T17:46:40\.000Z\); message: API rate limit exceeded.*x-ratelimit-reset: 1792000000/)
  })

  // The 401 rows: https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api (read 2026-10-20) does not document a 401 body, so the unauthenticated message is the one CAPTURE'd from api.github.com on 2026-10-20 (HTTP 401, message "Requires authentication") and the rejected-token message is HAND-DERIVED, not read from GitHub.
  it('tells the caller to set a token only when none was sent', async () => {
    const { fetchImpl } = refuseHistory({ status: 401, body: { message: 'Requires authentication' } })
    const error = await collect({ env: {}, fetchImpl }).catch((e: Error) => e)
    expect((error as Error).message).toContain('set GH_TOKEN')
    expect((error as Error).message).toContain('message: Requires authentication')
  })

  it('says the token was rejected, and does not ask for one, when a token was sent', async () => {
    const { fetchImpl } = refuseHistory({ status: 401, body: { message: 'Token refused (hand-derived)' } })
    const error = await collect({ env: { GH_TOKEN: 'ghs_secret_token' }, fetchImpl }).catch((e: Error) => e)
    const text = (error as Error).message
    expect(text).toContain('HTTP 401 (the token was rejected)')
    expect(text).toContain('message: Token refused (hand-derived)')
    expect(text).not.toContain('set GH_TOKEN')
    expect(text).not.toContain('ghs_secret_token')
  })

  it('reads a body that is not JSON and puts its start in the error', async () => {
    const { fetchImpl } = refuseHistory({ status: 403, body: '<html>Forbidden by the proxy</html>' })
    await expect(collect({ env: {}, fetchImpl })).rejects.toThrow(/HTTP 403; message: <html>Forbidden by the proxy<\/html>/)
  })
})

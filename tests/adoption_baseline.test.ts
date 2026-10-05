/** `scripts/adoption-baseline.mjs` rebuilds token-goat's weekly npm downloads, stars and forks from the public APIs, for the weekly `adoption.yml` job summary. Provenance: - `tests/fixtures/adoption/*.json` are CAPTURE: real responses fetched on 2026-09-29 from `api.npmjs.org/downloads/range/2026-06-25:2026-09-28/token-goat`, `api.npmjs.org/downloads/point/last-day/token-goat`, the first page of `api.github.com/repos/DFKHelper/token-goat/stargazers` (Accept `application/vnd.github.star+json`) and of `.../forks?sort=oldest`. The GitHub entries were cut to their first few and stripped to the one timestamp field the script reads, so no user login or id is committed. The range fixture keeps npm's zero-filled 2026-09-28, a day it had not counted yet when fetched: the last-day endpoint said 2026-09-27 at the same moment. - The repository's `created_at` (2026-05-16T00:31:24Z) is CAPTURE from `api.github.com/repos/DFKHelper/token-goat` on the same day. - The 401 status is CAPTURE: an unauthenticated GET of the stargazers list answered `401 Requires authentication` on 2026-09-29. - Week boundaries, sums and cumulative counts below are HAND-DERIVED from the fixture values and a calendar, not from the script. The real default `fetch` path runs against the live APIs in the dogfood run and in the weekly workflow; `collect` here gets an injected fetch that serves the captured bodies by URL. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { collect, dayMs, formatMarkdown, rangeChunks, starTimes, weeklySeries, weekStart } from '../scripts/adoption-baseline.mjs'

const FIXTURES = path.join(__dirname, 'fixtures', 'adoption')
const fixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as T

const range = fixture<{ downloads: Array<{ day: string; downloads: number }> }>('npm-range.json')
const lastDay = fixture<{ end: string }>('npm-last-day.json')
const stars = fixture<Array<{ starred_at: string }>>('stars.json')
const forks = fixture<Array<{ created_at: string }>>('forks.json')
const REPO_META = { created_at: '2026-05-16T00:31:24Z' }

type Served = { status?: number; body: unknown }
function fakeFetch(route: (url: URL) => Served) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const { status = 200, body } = route(new URL(url))
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) })
  }
  return { calls, fetchImpl }
}

function capturedApis(url: URL): Served {
  if (url.pathname === '/repos/DFKHelper/token-goat') return { body: REPO_META }
  if (url.pathname === '/downloads/point/last-day/token-goat') return { body: lastDay }
  if (url.pathname.startsWith('/downloads/range/')) return { body: range }
  if (url.pathname === '/repos/DFKHelper/token-goat/stargazers') return { body: stars }
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
  const rows = weeklySeries({ downloads: range.downloads, starredAt: starTimes(stars), forkedAt: forks.map((f) => f.created_at), start: '2026-06-25', end: lastDay.end })

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
    const early = weeklySeries({ downloads: [], starredAt: starTimes(stars), forkedAt: forks.map((f) => f.created_at), start: '2026-05-16', end: '2026-07-12' })
    const byWeek = Object.fromEntries(early.map((row) => [row.week, [row.stars, row.forks]]))
    expect(byWeek['2026-05-11']).toEqual([1, 1]) // week ends Sunday 05-17: the 05-17 star and fork
    expect(byWeek['2026-05-18']).toEqual([3, 1]) // both 05-18 stars
    expect(byWeek['2026-06-15']).toEqual([3, 3]) // forks of 06-15 and 06-16
    expect(byWeek['2026-06-29']).toEqual([3, 4]) // the 07-05 fork, a Sunday, falls in this week
  })
})

describe('starTimes', () => {
  it('refuses a stargazers page without starred_at instead of reading it as no stars', () => {
    expect(() => starTimes([{ login: 'x' }])).toThrow('application/vnd.github.star+json')
  })
})

describe('formatMarkdown', () => {
  it('shows a dash for the weeks before the first download and states the totals as of end', () => {
    const rows = weeklySeries({ downloads: range.downloads, starredAt: starTimes(stars), forkedAt: [], start: '2026-06-15', end: lastDay.end })
    const md = formatMarkdown({ rows, start: '2026-06-15', end: lastDay.end })
    expect(md).toContain('| 2026-06-15 | — | 3 | 0 |')
    expect(md).toContain('| 2026-06-22 | 1,586 | 3 | 0 |')
    expect(md).toContain('| 2026-09-21 | 2,182 | 3 | 0 |')
    expect(md.indexOf('| 2026-09-21 |')).toBeLessThan(md.indexOf('| 2026-06-15 |'))
    expect(md).toContain('At the end of 2026-09-27: 15,726 downloads in all, 3 stars, 0 forks.')
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
    expect(report.rows.at(-1)).toMatchObject({ week: '2026-09-21', downloads: 2182, stars: 3, forks: 4 })
    expect(calls.map((c) => new URL(c.url).pathname)).toContain('/downloads/range/2026-05-16:2026-09-27/token-goat')
    const starCall = calls.find((c) => c.url.includes('/stargazers'))
    expect(starCall?.headers).toMatchObject({ Accept: 'application/vnd.github.star+json', Authorization: 'Bearer tok' })
    expect(calls.find((c) => c.url.includes('/forks'))?.url).toContain('sort=oldest')
  })

  it('follows GitHub pages until one comes back short', async () => {
    const full = Array.from({ length: 100 }, () => ({ starred_at: '2026-06-01T00:00:00Z' }))
    const { calls, fetchImpl } = fakeFetch((url) => {
      if (url.pathname.endsWith('/stargazers')) return { body: url.searchParams.get('page') === '1' ? full : stars }
      return capturedApis(url)
    })
    const report = await collect({ since: '2026-09-21', env: {}, fetchImpl })
    expect(report.rows.at(-1)?.stars).toBe(103)
    expect(calls.filter((c) => c.url.includes('/stargazers')).map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('names GH_TOKEN when GitHub refuses the stargazer list without a token', async () => {
    const { fetchImpl } = fakeFetch((url) => (url.pathname.endsWith('/stargazers') ? { status: 401, body: { message: 'Requires authentication' } } : capturedApis(url)))
    await expect(collect({ env: {}, fetchImpl })).rejects.toThrow(/HTTP 401 \(GitHub needs a token for this: set GH_TOKEN/)
  })
})

export const PACKAGE: string
export const REPO: string
export const NPM_RANGE_DAYS: number

export interface WeekRow {
  week: string
  days: number
  partial: boolean
  downloads: number
  stars: number
  forks: number
}

export interface Report {
  start: string
  end: string
  rows: WeekRow[]
}

export function dayMs(day: string): number
export function isoDay(ms: number): string
export function weekStart(day: string): string
export function rangeChunks(start: string, end: string, maxDays?: number): Array<{ start: string; end: string }>
export function starTimes(page: unknown[]): string[]
export function forkTimes(page: unknown[]): string[]
export function weeklySeries(input: { downloads: Array<{ day: string; downloads: number }>; starredAt: string[]; forkedAt: string[]; start: string; end: string }): WeekRow[]
export function formatMarkdown(report: Report): string
export function collect(options?: { since?: string; env?: Record<string, string | undefined>; fetchImpl?: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> }): Promise<Report>

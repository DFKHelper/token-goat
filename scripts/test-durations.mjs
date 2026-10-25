#!/usr/bin/env node
// Lists the slowest test files of a vitest run from its captured log. Usage: node scripts/test-durations.mjs LOG [--top N], or LOG --failed to list the failing test files, or LOG --record STORE LEG to fold the log's per-file timings into the duration table next to the failure record STORE (the pre-push selection costs files from it). Reads the default reporter's per-file lines (`✓ tests/x.test.ts (N tests) 1234ms`, `❯` when a test failed), with or without colour codes. Built-in modules only, so the pre-push hook can run it before and without node_modules.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isMainModule } from './is-main-module.mjs'

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
// A file line starts with one space, a status mark and the path; sub-test lines are indented further and never match. The duration is absent for a skipped file, so such a line is not a timing and is dropped.
const FILE_LINE = /^ (?:✓|❯|×) (\S+\.(?:test|spec)\.[cm]?[jt]sx?) \(([^)]*)\) (\d+)ms$/

/** @param {string} text a vitest log @returns {{file: string, ms: number, detail: string}[]} one entry per file, the longest run when a file is listed twice */
export function parseDurations(text) {
  const byFile = new Map()
  for (const raw of text.replace(ANSI, '').split(/\r?\n/)) {
    const m = FILE_LINE.exec(raw.trimEnd())
    if (!m) continue
    const ms = Number(m[3])
    const seen = byFile.get(m[1])
    if (!seen || ms > seen.ms) byFile.set(m[1], { file: m[1], ms, detail: m[2] })
  }
  return [...byFile.values()]
}

const FAIL_LINE = /^ FAIL +(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?: |$)/
const FAILED_FILE_LINE = /^ (?:❯|×) (\S+\.(?:test|spec)\.[cm]?[jt]sx?) \([^)]*\bfailed\)/

/** @param {string} text a vitest log @returns {string[]} the test files with a failing test or a failed import, from the ` FAIL  file > test` lines and the per-file lines that count failures, in first-seen order */
export function parseFailedFiles(text) {
  const files = new Set()
  for (const raw of text.replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.trimEnd()
    const m = FAIL_LINE.exec(line) ?? FAILED_FILE_LINE.exec(line)
    if (m) files.add(m[1])
  }
  return [...files]
}

const SUMMARY_FAILED = /^ Test Files +(\d+) failed\b/
const CRASH_MARKER = /^(?:⎯+ )?Unhandled (?:Errors?|Rejections?)\b|^Vitest caught \d+ unhandled error|^\[vitest-pool\]:|^Error: Worker exited|^Unhandled Rejection/

/** @param {string} text a vitest log @returns {{files: string[], trusted: boolean, reason: string}} the failing files plus whether they are the whole story: false when a worker crash or unhandled error is reported, when failures were parsed without a summary line, or when the summary counts a different number of failed files */
export function parseFailedRun(text) {
  const files = parseFailedFiles(text)
  let summary = null
  let marker = ''
  for (const raw of text.replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.trimEnd()
    const s = SUMMARY_FAILED.exec(line)
    if (s) summary = (summary ?? 0) + Number(s[1])
    if (!marker && CRASH_MARKER.test(line)) marker = line.slice(0, 80)
  }
  if (marker) return { files, trusted: false, reason: `the log reports a worker crash or unhandled error (${marker})` }
  if (files.length > 0 && summary === null) return { files, trusted: false, reason: 'the log has failures but no "Test Files N failed" summary line' }
  if (summary !== null && summary !== files.length) return { files, trusted: false, reason: `the summary counts ${summary} failed file(s) but ${files.length} were parsed` }
  return { files, trusted: true, reason: '' }
}

/** @param {string} store the failure record's path @returns {string} the duration table that sits next to it, so one override (PREPUSH_FAILED_STORE) relocates both */
export function durationsPath(store) {
  return path.join(path.dirname(store), 'durations.json')
}

/** @param {string} file @param {string} leg @returns {Record<string, number>} test file -> last measured ms for that leg; an unreadable or malformed table is empty, so every file is then costed at the default */
export function readDurations(file, leg) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const legTable = data?.[leg]
    if (legTable === null || typeof legTable !== 'object' || Array.isArray(legTable)) return {}
    return Object.fromEntries(Object.entries(legTable).filter(([, ms]) => Number.isFinite(ms) && ms >= 0))
  } catch {
    return {}
  }
}

/** @param {string} file @param {string} leg @param {{file: string, ms: number}[]} entries a run's per-file timings; each replaces that file's earlier entry, files the run did not list keep theirs */
export function recordDurations(file, leg, entries) {
  if (entries.length === 0) return
  let data = {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
  } catch {
    // an absent or unreadable table starts again from this run
  }
  data[leg] = { ...readDurations(file, leg), ...Object.fromEntries(entries.map((e) => [e.file, e.ms])) }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`)
  renameSync(tmp, file)
}

/** @param {number[]} values @returns {number | null} the median, or null for no values */
export function medianMs(values) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/** @param {{file: string, ms: number, detail: string}[]} entries @param {number} n */
export function slowest(entries, n) {
  return [...entries].sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file)).slice(0, n)
}

/** @param {{file: string, ms: number, detail: string}[]} entries */
export function formatTable(entries) {
  return entries.map((e) => `${String(e.ms).padStart(8)}ms  ${e.file}  (${e.detail})`).join('\n')
}

const isMain = isMainModule(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const topAt = args.indexOf('--top')
  const top = topAt >= 0 ? Number(args[topAt + 1]) : 20
  const failedOnly = args.includes('--failed')
  const recordAt = args.indexOf('--record')
  const log = args.find((a, i) => !a.startsWith('--') && (topAt < 0 || i !== topAt + 1) && (recordAt < 0 || (i !== recordAt + 1 && i !== recordAt + 2)))
  if (!log || !Number.isInteger(top) || top < 1) {
    process.stderr.write('usage: node scripts/test-durations.mjs LOG [--top N]\n')
    process.exit(2)
  }
  if (recordAt >= 0) {
    const [store, leg] = [args[recordAt + 1], args[recordAt + 2]]
    if (!log || !store || !leg) {
      process.stderr.write('usage: node scripts/test-durations.mjs LOG --record STORE LEG\n')
      process.exit(2)
    }
    const entries = parseDurations(readFileSync(log, 'utf8'))
    recordDurations(durationsPath(store), leg, entries)
    process.stdout.write(`recorded ${entries.length} test file timing(s) for ${leg}\n`)
    process.exit(0)
  }
  if (failedOnly) {
    for (const f of parseFailedFiles(readFileSync(log, 'utf8'))) process.stdout.write(`${f}\n`)
    process.exit(0)
  }
  const entries = parseDurations(readFileSync(log, 'utf8'))
  if (entries.length === 0) {
    process.stdout.write(`no per-file timings found in ${log}\n`)
  } else {
    process.stdout.write(`${formatTable(slowest(entries, top))}\n`)
  }
}

#!/usr/bin/env node
// Lists the slowest test files of a vitest run from its captured log. Usage: node scripts/test-durations.mjs LOG [--top N], or LOG --failed to list the failing test files. Reads the default reporter's per-file lines (`✓ tests/x.test.ts (N tests) 1234ms`, `❯` when a test failed), with or without colour codes. Built-in modules only, so the pre-push hook can run it before and without node_modules.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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

/** @param {{file: string, ms: number, detail: string}[]} entries @param {number} n */
export function slowest(entries, n) {
  return [...entries].sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file)).slice(0, n)
}

/** @param {{file: string, ms: number, detail: string}[]} entries */
export function formatTable(entries) {
  return entries.map((e) => `${String(e.ms).padStart(8)}ms  ${e.file}  (${e.detail})`).join('\n')
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const topAt = args.indexOf('--top')
  const top = topAt >= 0 ? Number(args[topAt + 1]) : 20
  const failedOnly = args.includes('--failed')
  const log = args.find((a, i) => !a.startsWith('--') && (topAt < 0 || i !== topAt + 1))
  if (!log || !Number.isInteger(top) || top < 1) {
    process.stderr.write('usage: node scripts/test-durations.mjs LOG [--top N]\n')
    process.exit(2)
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

#!/usr/bin/env node
// Lists the slowest test files of a vitest run from its captured log. Usage: node scripts/test-durations.mjs LOG [--top N]. Reads the default reporter's per-file lines (`✓ tests/x.test.ts (N tests) 1234ms`, `❯` when a test failed), with or without colour codes. Built-in modules only, so the pre-push hook can run it before and without node_modules.
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
  const log = args.find((a, i) => !a.startsWith('--') && (topAt < 0 || i !== topAt + 1))
  if (!log || !Number.isInteger(top) || top < 1) {
    process.stderr.write('usage: node scripts/test-durations.mjs LOG [--top N]\n')
    process.exit(2)
  }
  const entries = parseDurations(readFileSync(log, 'utf8'))
  if (entries.length === 0) {
    process.stdout.write(`no per-file timings found in ${log}\n`)
  } else {
    process.stdout.write(`${formatTable(slowest(entries, top))}\n`)
  }
}

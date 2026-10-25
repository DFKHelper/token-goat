#!/usr/bin/env node
// Keeps the record of which test files failed in the last pre-push, per leg, so the next push can re-run just those. Usage: node scripts/prepush-failed.mjs record STORE LEG SHA LOG | read STORE LEG | clear STORE LEG. `read` prints the recorded sha, then one failing file per line, and exits 1 when the leg has no record. Built-in modules only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isMainModule } from './is-main-module.mjs'
import { parseFailedRun } from './test-durations.mjs'

/** @param {string} store @returns {Record<string, {sha: string, files: string[]}>} an unreadable or malformed store counts as empty, so the next run is a full one */
export function loadStore(store) {
  try {
    const data = JSON.parse(readFileSync(store, 'utf8'))
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

function saveStore(store, data) {
  mkdirSync(path.dirname(store), { recursive: true })
  const tmp = `${store}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, store)
}

/** @param {string} store @param {string} leg @param {string} sha @param {string[]} files the failing test files @param {boolean} [unparsed] true when the leg was red but no failing file could be read from its log: the next focused selection then falls back to the full leg (hasUnparsedFailure), while a plain empty list clears the leg */
export function recordFailure(store, leg, sha, files, unparsed = false) {
  const data = loadStore(store)
  if (files.length === 0 && unparsed) data[leg] = { sha, files: [], unparsed: true }
  else if (files.length === 0) delete data[leg]
  else data[leg] = { sha, files }
  saveStore(store, data)
}

/** @param {string} store @param {string} leg @returns {{sha: string, files: string[]} | null} */
export function readFailure(store, leg) {
  const entry = loadStore(store)[leg]
  if (!entry || typeof entry.sha !== 'string' || !Array.isArray(entry.files)) return null
  const files = entry.files.filter((f) => typeof f === 'string' && f !== '')
  return files.length > 0 && entry.sha !== '' ? { sha: entry.sha, files } : null
}

/** @param {string} store @param {string} leg @returns {boolean} true when the leg's last red run named no failing file */
export function hasUnparsedFailure(store, leg) {
  const entry = loadStore(store)[leg]
  return entry !== null && typeof entry === 'object' && entry.unparsed === true
}

/** @param {string} store @param {string} leg */
export function clearFailure(store, leg) {
  const data = loadStore(store)
  if (!(leg in data)) return
  delete data[leg]
  saveStore(store, data)
}

const isMain = isMainModule(import.meta.url)
if (isMain) {
  const [cmd, store, leg, sha, log] = process.argv.slice(2)
  if (cmd === 'record' && store && leg && sha && log) {
    const run = parseFailedRun(readFileSync(log, 'utf8'))
    const files = run.trusted ? run.files : []
    recordFailure(store, leg, sha, files, files.length === 0)
    if (!run.trusted) process.stdout.write(`${run.reason}; the next ${leg} run will be full\n`)
    else process.stdout.write(files.length > 0 ? `recorded ${files.length} failing file(s) for ${leg}\n` : `no failing test file found in ${log}; the next ${leg} run will be full\n`)
  } else if (cmd === 'read' && store && leg) {
    const rec = readFailure(store, leg)
    if (!rec) process.exit(1)
    process.stdout.write(`${rec.sha}\n${rec.files.join('\n')}\n`)
  } else if (cmd === 'clear' && store && leg) {
    clearFailure(store, leg)
  } else {
    process.stderr.write('usage: node scripts/prepush-failed.mjs record STORE LEG SHA LOG | read STORE LEG | clear STORE LEG\n')
    process.exit(2)
  }
}

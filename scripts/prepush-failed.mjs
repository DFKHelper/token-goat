#!/usr/bin/env node
// Keeps the record of which test files failed in the last pre-push, per leg, so the next push can re-run just those. Usage: node scripts/prepush-failed.mjs record STORE LEG SHA LOG | read STORE LEG | clear STORE LEG. `read` prints the recorded sha, then one failing file per line, and exits 1 when the leg has no record. Built-in modules only.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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

/** @param {string} store @param {string} leg @param {string} sha @param {string[]} files the failing test files; an empty list clears the leg, since a focused run could not be chosen from it */
export function recordFailure(store, leg, sha, files) {
  const data = loadStore(store)
  if (files.length === 0) delete data[leg]
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

/** @param {string} store @param {string} leg */
export function clearFailure(store, leg) {
  const data = loadStore(store)
  if (!(leg in data)) return
  delete data[leg]
  saveStore(store, data)
}

// import.meta.url is the entry module's real path while argv[1] keeps any symlink it was started through (macOS /var and /tmp), so compare the resolved path or the CLI silently does nothing
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (isMain) {
  const [cmd, store, leg, sha, log] = process.argv.slice(2)
  if (cmd === 'record' && store && leg && sha && log) {
    const run = parseFailedRun(readFileSync(log, 'utf8'))
    const files = run.trusted ? run.files : []
    recordFailure(store, leg, sha, files)
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

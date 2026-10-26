#!/usr/bin/env node
// Keeps the record of which test files failed in the last pre-push, per leg, so the next push can re-run just those. Usage: node scripts/prepush-failed.mjs record STORE LEG SHA LOG | read STORE LEG | clear STORE LEG. `read` prints the recorded sha, then one failing file per line, and exits 1 when the leg has no record. A store that cannot be parsed makes the next selection a full one (hasUnparsedFailure) and is moved aside to STORE.corrupt by the next write. Built-in modules only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isMainModule } from './is-main-module.mjs'
import { parseFailedRun } from './test-durations.mjs'

/** @param {unknown} e @returns {boolean} true for a missing-file error */
function isMissing(e) {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT'
}

/** @param {string} store @returns {{data: Record<string, {sha: string, files: string[], unparsed?: boolean}>, corrupt: boolean}} an absent store is empty and sound; one that cannot be read or parsed, or is not an object, is empty and corrupt, which is never a license for a focused run */
export function inspectStore(store) {
  let text
  try {
    text = readFileSync(store, 'utf8')
  } catch (e) {
    return { data: {}, corrupt: !isMissing(e) }
  }
  try {
    const data = JSON.parse(text)
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? { data, corrupt: false } : { data: {}, corrupt: true }
  } catch {
    return { data: {}, corrupt: true }
  }
}

/** @param {string} store @returns {Record<string, {sha: string, files: string[], unparsed?: boolean}>} the store's content, empty when it is absent or corrupt (inspectStore tells the two apart) */
export function loadStore(store) {
  return inspectStore(store).data
}

function saveStore(store, data) {
  mkdirSync(path.dirname(store), { recursive: true })
  const tmp = `${store}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, store)
}

/** @param {string} store moves a store that could not be parsed to `<store>.corrupt` (replacing an older one), so a write never destroys what it could not read */
function quarantine(store) {
  try {
    renameSync(store, `${store}.corrupt`)
  } catch (e) {
    if (!isMissing(e)) throw e
  }
}

/** @param {unknown} entry @returns {boolean} true for a leg entry recordFailure writes: failing files under a sha, or the unparsed mark */
function isSoundEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false
  if (entry.unparsed === true) return true
  return typeof entry.sha === 'string' && entry.sha !== '' && Array.isArray(entry.files) && entry.files.some((f) => typeof f === 'string' && f !== '')
}

/** @param {string} store @param {string} leg @param {string} sha @param {string[]} files the failing test files @param {boolean} [unparsed] true when the leg was red but no failing file could be read from its log: the next focused selection then falls back to the full leg (hasUnparsedFailure), while a plain empty list clears the leg @returns {boolean} true when the store could not be parsed and was moved aside to `<store>.corrupt` first */
export function recordFailure(store, leg, sha, files, unparsed = false) {
  const { data, corrupt } = inspectStore(store)
  if (corrupt) quarantine(store)
  if (files.length === 0 && unparsed) data[leg] = { sha, files: [], unparsed: true }
  else if (files.length === 0) delete data[leg]
  else data[leg] = { sha, files }
  saveStore(store, data)
  return corrupt
}

/** @param {string} store @param {string} leg @returns {{sha: string, files: string[]} | null} */
export function readFailure(store, leg) {
  const entry = loadStore(store)[leg]
  if (!entry || typeof entry.sha !== 'string' || !Array.isArray(entry.files)) return null
  const files = entry.files.filter((f) => typeof f === 'string' && f !== '')
  return files.length > 0 && entry.sha !== '' ? { sha: entry.sha, files } : null
}

/** @param {string} store @param {string} leg @returns {boolean} true when the failing files of the leg's last run are unknown: the store is corrupt, the leg's entry is not one recordFailure writes, or the last red run named no failing file */
export function hasUnparsedFailure(store, leg) {
  const { data, corrupt } = inspectStore(store)
  if (corrupt) return true
  const entry = data[leg]
  return entry !== undefined && (!isSoundEntry(entry) || entry.unparsed === true)
}

/** @param {string} store @param {string} leg a corrupt store is moved aside, so a green run ends the full runs it caused */
export function clearFailure(store, leg) {
  const { data, corrupt } = inspectStore(store)
  if (corrupt) {
    quarantine(store)
    return
  }
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
    if (recordFailure(store, leg, sha, files, files.length === 0)) process.stdout.write(`${store} could not be parsed and was moved to ${store}.corrupt\n`)
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

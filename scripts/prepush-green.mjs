#!/usr/bin/env node
// Reuses a green check or test file when the identical bytes already passed. The key is a git tree id of the working tree made through a temporary index (so unstaged and untracked, non-ignored edits change it), the leg, the platform, the node version, a hash of the installed-dependency record, the env knobs that can change a result and, for the test legs, a hash of dist/. Usage: node scripts/prepush-green.mjs id | run NAME [--leg LEG] -- CMD ARGS... | filter LEG FOCUS_FILE TREE_FILE | record-files LEG FOCUS_FILE TREE_FILE. PREPUSH_FULL=1 ignores every record; TG_PREPUSH_NO_REUSE=1 neither reads nor writes one. Built-in modules only.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isMainModule } from './is-main-module.mjs'

/** The most entries the record file keeps, oldest dropped first. */
export const MAX_ENTRIES = 32
/** The leg the static checks (lint, typecheck, guards) record under, shared by the pre-commit and pre-push tiers. */
export const STATIC_LEG = 'static'
const GUARDS_CHECK = 'guards'
const GUARDS_DIR = 'tests/guards/'
// Env names whose value can change what a check or test does; PREPUSH_ and TG_PREPUSH_ knobs steer the hook, not the result. PATH, HOME and the like are not keyed.
const ENV_KEYED = /^(?:TG_|TOKEN_GOAT_|NODE_OPTIONS$|NODE_ENV$|CI$|TZ$)/
const ENV_UNKEYED = /^(?:TG_)?PREPUSH_/

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** @param {Record<string, string | undefined>} env @returns {boolean} true when the record must be ignored for reading (PREPUSH_FULL=1) or entirely (TG_PREPUSH_NO_REUSE=1) */
export function reuseOff(env) {
  return env.PREPUSH_FULL === '1' || env.TG_PREPUSH_NO_REUSE === '1'
}

/** @param {Record<string, string | undefined>} env @returns {boolean} true when no record may be written either */
export function recordOff(env) {
  return env.TG_PREPUSH_NO_REUSE === '1'
}

function git(root, args, env) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: env ?? process.env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return res.status === 0 ? res.stdout.trim() : null
}

/** @param {string} root @returns {string | null} the tree id of the working tree (tracked, unstaged and untracked non-ignored files), or null when it cannot be made; never touches the real index */
export function treeId(root) {
  const gitDir = git(root, ['rev-parse', '--path-format=absolute', '--git-dir'])
  if (!gitDir) return null
  const tmp = path.join(gitDir, `token-goat-green-${process.pid}-${randomBytes(4).toString('hex')}.index`)
  try {
    const real = process.env.GIT_INDEX_FILE || git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    const env = { ...process.env, GIT_INDEX_FILE: tmp }
    if (real && existsSync(real)) copyFileSync(real, tmp)
    else if (git(root, ['read-tree', 'HEAD'], env) === null) return null
    if (git(root, ['add', '-A'], env) === null) return null
    const id = git(root, ['write-tree'], env)
    return id && /^[0-9a-f]{40,64}$/.test(id) ? id : null
  } catch {
    return null
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** @param {string} dir @param {string[]} out collects `relpath:sha` for every file under dir */
function hashTree(dir, base, out) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) hashTree(full, base, out)
    else if (e.isFile()) out.push(`${path.relative(base, full)}:${sha256(readFileSync(full))}`)
  }
}

/** @param {string} root @param {string} leg @param {Record<string, string | undefined>} env @returns {object} the key fields besides the tree id; a test leg also keys the built bundle (dist/ is ignored, so the tree id does not see it) */
export function keyParts(root, leg, env = process.env) {
  let deps = 'none'
  try {
    deps = sha256(readFileSync(path.join(root, 'node_modules', '.package-lock.json')))
  } catch {
    // no installed-dependency record: keyed as none, so it matches only another run without one
  }
  let dist = 'n/a'
  if (leg !== STATIC_LEG) {
    dist = 'none'
    try {
      const lines = []
      hashTree(path.join(root, 'dist'), root, lines)
      dist = sha256(lines.join('\n'))
    } catch {
      // no dist: keyed as none
    }
  }
  const envLines = Object.keys(env).filter((k) => ENV_KEYED.test(k) && !ENV_UNKEYED.test(k) && env[k] !== undefined).sort().map((k) => `${k}=${env[k]}`)
  return { leg, platform: process.platform, node: process.version, deps, dist, env: sha256(envLines.join('\n')) }
}

/** @param {string} root @returns {string | null} where the record lives: PREPUSH_GREEN_STORE, else token-goat-prepush/green.json under the git common dir */
export function storePath(root, env = process.env) {
  if (env.PREPUSH_GREEN_STORE) return env.PREPUSH_GREEN_STORE
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return common ? path.join(common, 'token-goat-prepush', 'green.json') : null
}

const isEntry = (e) =>
  e !== null && typeof e === 'object' && typeof e.tree === 'string' && typeof e.at === 'number' && Array.isArray(e.done) && e.done.every((d) => typeof d === 'string') &&
  ['leg', 'platform', 'node', 'deps', 'dist', 'env'].every((k) => typeof e[k] === 'string')

/** @param {string} store @returns {object[]} the sound entries; a missing, unreadable or malformed file is empty, which only ever costs a re-run */
export function readEntries(store) {
  try {
    const data = JSON.parse(readFileSync(store, 'utf8'))
    return Array.isArray(data?.entries) ? data.entries.filter(isEntry) : []
  } catch {
    return []
  }
}

const sameKey = (e, tree, parts) => e.tree === tree && Object.keys(parts).every((k) => e[k] === parts[k])

/** @param {string} store @param {string} tree @param {object} parts @param {string} name @returns {boolean} true when this exact name is recorded green on this exact key */
export function isGreen(store, tree, parts, name) {
  return readEntries(store).some((e) => sameKey(e, tree, parts) && e.done.includes(name))
}

/** @param {string} store @param {string} tree @param {object} parts @param {string[]} names @param {number} [now] adds the names to the entry of this key, newest entries last, at most MAX_ENTRIES kept; atomic by rename, so a concurrent writer can drop this update but never corrupt the file */
export function recordGreen(store, tree, parts, names, now = Date.now()) {
  const entries = readEntries(store)
  const hit = entries.find((e) => sameKey(e, tree, parts))
  const rest = entries.filter((e) => e !== hit)
  const done = [...new Set([...(hit?.done ?? []), ...names])]
  const next = [...rest, { tree, ...parts, done, at: now }].sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES)
  mkdirSync(path.dirname(store), { recursive: true })
  const tmp = `${store}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify({ entries: next }, null, 1)}\n`)
    renameSync(tmp, store)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

const quoteWin = (a) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)

/** @param {string} root @param {string} name @param {string} leg @param {string[]} cmd @param {Record<string, string | undefined>} env @returns {number} the exit code: 0 for a reused green result without running, else the command's own code; a green run on an unmoved tree is recorded */
export function runChecked(root, name, leg, cmd, env = process.env) {
  const store = storePath(root, env)
  const before = store && !recordOff(env) ? treeId(root) : null
  const parts = before ? keyParts(root, leg, env) : null
  if (before && parts && store && !reuseOff(env) && isGreen(store, before, parts, name)) {
    process.stdout.write(`pre-push: reused green ${name} (same tree ${before.slice(0, 12)}, ${leg}, ${process.platform}, node ${process.version})\n`)
    return 0
  }
  const win = process.platform === 'win32'
  const res = spawnSync(win ? cmd.map(quoteWin).join(' ') : cmd[0], win ? [] : cmd.slice(1), { cwd: root, stdio: 'inherit', shell: win, env })
  if (res.status !== 0) return res.status ?? 1
  if (before && parts && store && treeId(root) === before) {
    try {
      recordGreen(store, before, parts, [name])
    } catch {
      // a record that cannot be written only costs a re-run
    }
  }
  return 0
}

/** @param {string[]} files test files in order @param {object[]} entries @param {string} tree @param {object} parts the leg's key parts @param {object} staticParts @returns {{keep: string[], reused: string[]}} the files not yet green; a file under tests/guards/ is green when the static guards check is */
export function splitGreen(files, entries, tree, parts, staticParts) {
  const own = new Set(entries.filter((e) => sameKey(e, tree, parts)).flatMap((e) => e.done))
  const guards = entries.some((e) => sameKey(e, tree, staticParts) && e.done.includes(GUARDS_CHECK))
  const keep = []
  const reused = []
  for (const f of files) (own.has(f) || (guards && f.startsWith(GUARDS_DIR)) ? reused : keep).push(f)
  return { keep, reused }
}

const readList = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')

function main(argv, root, env) {
  const [cmd, ...rest] = argv
  if (cmd === 'id') {
    const id = treeId(root)
    if (!id) return 1
    process.stdout.write(`${id}\n`)
    return 0
  }
  if (cmd === 'run') {
    const sep = rest.indexOf('--')
    const name = rest[0]
    const legAt = rest.indexOf('--leg')
    const leg = legAt > -1 && legAt < sep ? rest[legAt + 1] : STATIC_LEG
    if (!name || sep < 1 || sep === rest.length - 1) {
      process.stderr.write('usage: node scripts/prepush-green.mjs run NAME [--leg LEG] -- CMD ARGS...\n')
      return 2
    }
    return runChecked(root, name, leg, rest.slice(sep + 1), env)
  }
  if (cmd === 'filter' || cmd === 'record-files') {
    const [leg, focus, treeFile] = rest
    if (!leg || !focus || !treeFile) return 2
    const store = storePath(root, env)
    if (cmd === 'filter') {
      writeFileSync(treeFile, '')
      if (!store || recordOff(env)) return 0
      const tree = treeId(root)
      if (!tree) return 0
      writeFileSync(treeFile, `${tree}\n`)
      if (reuseOff(env)) return 0
      const files = readList(focus)
      const { keep, reused } = splitGreen(files, readEntries(store), tree, keyParts(root, leg, env), keyParts(root, STATIC_LEG, env))
      if (reused.length > 0) {
        writeFileSync(focus, keep.map((f) => `${f}\n`).join(''))
        process.stdout.write(`pre-push: reused ${reused.length} green test file(s) on the same tree ${tree.slice(0, 12)} (${leg}, ${process.platform}, node ${process.version}): ${reused.slice(0, 8).join(', ')}${reused.length > 8 ? ', ...' : ''}; ${keep.length} left to run\n`)
      }
      return 0
    }
    const start = existsSync(treeFile) ? readFileSync(treeFile, 'utf8').trim() : ''
    if (!start || !store || recordOff(env) || treeId(root) !== start) return 0
    try {
      recordGreen(store, start, keyParts(root, leg, env), readList(focus))
    } catch {
      // a record that cannot be written only costs a re-run
    }
    return 0
  }
  process.stderr.write('usage: node scripts/prepush-green.mjs id | run NAME [--leg LEG] -- CMD... | filter LEG FOCUS TREE_FILE | record-files LEG FOCUS TREE_FILE\n')
  return 2
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), git(process.cwd(), ['rev-parse', '--show-toplevel']) ?? process.cwd(), process.env)
}

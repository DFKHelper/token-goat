#!/usr/bin/env node
/** scripts/sync-arch-docs.mjs Keeps the component table in CLAUDE.arch.md in sync with the tracked source modules. Renders the arch-doc-sync skill's flat table, `| Module | Layer | Role | Key exports |`, between the ARCH_COMPONENTS markers and leaves everything outside them alone. The table contract is SKILL.md "Component Table Contract" and the config is its "Config"; the config for this repo is config/arch-docs.json. Usage: node scripts/sync-arch-docs.mjs [--check | --write]   (no flag writes) --check  read-only; findings go to stderr, stdout stays empty; exit 1 on drift. --write  rewrite the table in place; exit 0. Exit codes: 0 in sync (or written), 1 drift, 2 configuration or usage error. Not implemented, deliberately: --staged, --format=json, rename/split/merge of curated roles, layer-order and cycle checks, folder roots and Python/Go modules. A curated Role is never overwritten; an obsolete row is dropped. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isMainModule } from './is-main-module.mjs'
import { ArchDocError, globMatch, isCodeFile, layerFor, loadConfig, selectRoot } from './arch-docs/config.mjs'
import { jsExports } from './arch-docs/exports.mjs'
import { jsDocSentence, templateRole } from './arch-docs/prose.mjs'
import {
  NO_EXPORTS, assertNoLoneCr, assertTableable, byteCompare, currentInner, detectNewline, END_MARKER, findMarkers,
  parseTable, renderTable, splice, START_MARKER, toNewline,
} from './arch-docs/table.mjs'

const MAX_EXPORTS = 5
const GIT_MAX_BUFFER = 256 * 1024 * 1024
const USAGE = 'usage: node scripts/sync-arch-docs.mjs [--check | --write]'

function runGit(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true })
  if (result.error && result.error.code === 'ENOENT') throw new ArchDocError('git executable not found on PATH')
  return result.status === 0 && !result.error ? result.stdout : null
}

function repoRoot(cwd) {
  const out = runGit(cwd, ['rev-parse', '--show-toplevel'])
  const root = out === null ? '' : out.toString('utf8').trim()
  if (root === '') throw new ArchDocError('not inside a git work tree')
  return path.resolve(root)
}

/** Tracked paths only, never a filesystem walk: the list is the same on every machine. */
function listTracked(root) {
  const out = runGit(root, ['ls-files', '-z'])
  if (out === null) throw new ArchDocError('not inside a git work tree (git ls-files failed)')
  return [...new Set(out.toString('utf8').split('\0').filter((entry) => entry !== ''))]
}

/** Contents of a regular file inside the repo, or null when it is missing or is a symlink or directory. */
function readRegular(root, rel) {
  const absolute = path.join(root, rel)
  try {
    return fs.lstatSync(absolute).isFile() ? fs.readFileSync(absolute, 'utf8') : null
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

/** The modules the tracked files add up to, and the files an exclude pattern dropped. */
function discover(config, tracked) {
  const components = []
  const excluded = []
  for (const file of tracked) {
    if (selectRoot(config.roots, file) === undefined || !isCodeFile(file)) continue
    if (config.exclude.some((pattern) => globMatch(pattern, file))) {
      excluded.push(file)
      continue
    }
    assertTableable(file)
    components.push(file)
  }
  components.sort(byteCompare)
  return { components, excluded: excluded.sort(byteCompare) }
}

/** Role and exports a module would get with no curated text: its first doc-comment sentence, else the layer template. */
function describeModule(key, layer, text) {
  const exports = jsExports(text, key.slice(key.lastIndexOf('.'))).slice(0, MAX_EXPORTS)
  return { autoRole: jsDocSentence(text) ?? templateRole(key, layer), exports: exports.length > 0 ? exports.join(', ') : NO_EXPORTS }
}

/** The documented Role, when it is curated: non-empty and not text this engine could have generated for the module. */
function keptRole(existing, generated) {
  const role = existing === undefined ? '' : existing.role.trim()
  return role === '' || generated.has(role) ? null : role
}

function plan(root, config) {
  const docText = readRegular(root, config.doc)
  if (docText === null) throw new ArchDocError(`${config.doc}: architecture doc not found`)
  assertNoLoneCr(docText, config.doc)
  const markers = findMarkers(docText)
  const documented = parseTable(currentInner(docText, markers))
  const { components, excluded } = discover(config, listTracked(root))
  const rows = new Map()
  for (const key of components) {
    const text = readRegular(root, key)
    if (text === null) continue
    const layer = layerFor(key, config.layers)
    const { autoRole, exports } = describeModule(key, layer, text)
    const existing = documented.get(key)
    const generated = new Set([autoRole, templateRole(key, layer)])
    if (existing !== undefined) generated.add(templateRole(key, existing.layer))
    rows.set(key, { module: key, layer, role: keptRole(existing, generated) ?? autoRole, exports })
  }
  const generatedInner = toNewline(renderTable(rows.values(), config.layers), detectNewline(docText))
  if (generatedInner.includes(START_MARKER) || generatedInner.includes(END_MARKER)) {
    throw new ArchDocError('generated table contains a sync marker; refusing to write it')
  }
  return { docText, markers, documented, rows, excluded, generatedInner }
}

/** Findings in the skill's `--check` order: undocumented, obsolete, stale, then a layout-only difference. */
function findings(p, doc) {
  const unmapped = [...p.rows.keys()].filter((key) => !p.documented.has(key)).sort(byteCompare)
  const obsolete = [...p.documented.keys()].filter((key) => !p.rows.has(key)).sort(byteCompare)
  const stale = [...p.rows.keys()]
    .filter((key) => {
      const had = p.documented.get(key)
      const row = p.rows.get(key)
      return had !== undefined && (had.layer !== row.layer || had.role !== row.role || had.exports !== row.exports)
    })
    .sort(byteCompare)
  const layoutDrift = unmapped.length + obsolete.length + stale.length === 0 && p.generatedInner !== currentInner(p.docText, p.markers)
  const lines = [
    ...unmapped.map((key) => `error: ${key}: undocumented module, run --write`),
    ...obsolete.map((key) => `error: ${key}: obsolete entry, module no longer exists`),
    ...stale.map((key) => `error: ${key}: stale entry, run --write`),
    ...(layoutDrift ? [`error: ${doc}: table layout differs from generated output, run --write`] : []),
  ]
  return { drift: lines.length > 0, lines }
}

function writeAtomic(target, data) {
  const temp = `${target}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temp, data, { mode: fs.statSync(target).mode })
    fs.renameSync(temp, target)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

function parseArgs(argv) {
  let mode
  for (const arg of argv) {
    if ((arg !== '--check' && arg !== '--write') || (mode !== undefined && mode !== arg)) {
      throw new ArchDocError(`${arg === '--check' || arg === '--write' ? 'conflicting' : 'unknown'} argument ${JSON.stringify(arg)}\n${USAGE}`)
    }
    mode = arg
  }
  return mode === '--check' ? 'check' : 'write'
}

/** Runs the engine from `cwd` and returns the exit code: 0 in sync or written, 1 drift, 2 configuration or usage error. Findings go through `stderr`, one line each; nothing is ever written to stdout. */
export function runCli(argv, { cwd = process.cwd(), stderr = (line) => process.stderr.write(`${line}\n`) } = {}) {
  try {
    const mode = parseArgs(argv)
    const root = repoRoot(cwd)
    const config = loadConfig({
      has: (rel) => fs.existsSync(path.join(root, rel)),
      read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    })
    const p = plan(root, config)
    if (mode === 'check') {
      const result = findings(p, config.doc)
      for (const line of result.lines) stderr(line)
      return result.drift ? 1 : 0
    }
    if (p.generatedInner !== currentInner(p.docText, p.markers)) {
      writeAtomic(path.join(root, config.doc), splice(p.docText, p.markers, p.generatedInner))
      stderr(`info: ${config.doc}: updated (${p.rows.size} modules)`)
    }
    return 0
  } catch (error) {
    if (!(error instanceof ArchDocError)) throw error
    stderr(`error: ${error.message}`)
    return 2
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2))
}

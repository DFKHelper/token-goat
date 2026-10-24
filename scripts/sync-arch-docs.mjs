#!/usr/bin/env node
/** scripts/sync-arch-docs.mjs Keeps the component table in CLAUDE.arch.md in sync with the tracked source modules. Renders the arch-doc-sync skill's flat table, `| Module | Layer | Role | Key exports |`, between the ARCH_COMPONENTS markers and leaves everything outside them alone. The table contract is SKILL.md "Component Table Contract" and the config is its "Config"; the config for this repo is config/arch-docs.json. Usage: node scripts/sync-arch-docs.mjs [--check | --write] [--staged] [--format text|json]   (no mode flag writes) --check  read-only; findings go to stderr, stdout stays empty; exit 1 on drift. --check --staged  check the commit about to be made: the doc, config, file list, renames and contents come from the git index. --check --format=json  one compact JSON object on stdout instead of the findings. --write  rewrite the table in place; exit 0. Exit codes: 0 in sync (or written), 1 drift, 2 configuration or usage error. A curated Role is never overwritten; it follows a rename, is copied to each child of a split, the longest one survives a merge, and each of those (and each drop) is reported as a warning (--check) or an info line (--write). Not implemented, deliberately: layer-order, cycle and side-effect checks (the JSON keys for them are empty arrays), folder roots and Python/Go modules. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isMainModule } from './is-main-module.mjs'
import { ArchDocError, CONFIG_CANDIDATES, globMatch, isCodeFile, layerFor, loadConfig, selectRoot } from './arch-docs/config.mjs'
import { droppedRoleNotes, keptRole, resolveRenames } from './arch-docs/curated.mjs'
import { jsExports } from './arch-docs/exports.mjs'
import { jsDocSentence, templateRole } from './arch-docs/prose.mjs'
import { existsOnDisk, headReader, indexSource, repoRoot, worktreeSource } from './arch-docs/source.mjs'
import {
  NO_EXPORTS, assertNoLoneCr, assertTableable, byteCompare, currentInner, detectNewline, END_MARKER, findMarkers,
  parseTable, renderTable, splice, START_MARKER, toNewline,
} from './arch-docs/table.mjs'

const MAX_EXPORTS = 5
const USAGE = 'usage: node scripts/sync-arch-docs.mjs [--check | --write] [--staged] [--format text|json]'

const isComponentFile = (config, file) => selectRoot(config.roots, file) !== undefined && isCodeFile(file) && !config.exclude.some((pattern) => globMatch(pattern, file))

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

/** The auto role a module had at HEAD under `layer`, or null when HEAD has no readable component at that path. */
function headAutoRoles(root, config) {
  const head = headReader(root)
  return (key, layer) => {
    const text = isComponentFile(config, key) ? head.text(key) : null
    return text === null ? null : describeModule(key, layer, text).autoRole
  }
}

function plan(root, config, source) {
  const docText = source.read(config.doc)
  if (docText === null) throw new ArchDocError(`${config.doc}: architecture doc not found${source.docMissingSuffix}`)
  assertNoLoneCr(docText, config.doc)
  const markers = findMarkers(docText)
  const documented = parseTable(currentInner(docText, markers))
  const { components, excluded } = discover(config, source.files)
  const texts = source.readAll(components)
  const described = new Map()
  for (const key of components) {
    const text = texts.get(key)
    if (text === undefined) continue
    const layer = layerFor(key, config.layers)
    described.set(key, { layer, ...describeModule(key, layer, text) })
  }
  const resolution = resolveRenames({
    documented,
    current: new Set(described.keys()),
    records: source.renames,
    isComponent: (file) => isComponentFile(config, file),
    autoRole: (key) => described.get(key)?.autoRole ?? '',
    headAutoRole: headAutoRoles(root, config),
  })
  const rows = new Map()
  for (const [key, { layer, autoRole, exports }] of described) {
    const existing = documented.get(key)
    const generated = new Set([autoRole, templateRole(key, layer)])
    if (existing !== undefined) generated.add(templateRole(key, existing.layer))
    rows.set(key, { module: key, layer, role: resolution.overrides.get(key) ?? keptRole(existing, generated) ?? autoRole, exports })
  }
  const obsolete = [...documented.keys()].filter((key) => !rows.has(key) && !resolution.renamedAway.has(key)).sort(byteCompare)
  const notes = [...new Set([...resolution.notes, ...droppedRoleNotes(documented, obsolete)])].sort(byteCompare)
  const generatedInner = toNewline(renderTable(rows.values(), config.layers), detectNewline(docText))
  if (generatedInner.includes(START_MARKER) || generatedInner.includes(END_MARKER)) {
    throw new ArchDocError('generated table contains a sync marker; refusing to write it')
  }
  return { docText, markers, documented, rows, obsolete, notes, excluded, generatedInner }
}

/** What `--check` found, in the skill's order: undocumented, obsolete, stale, then a layout-only difference; `notes` are the curated-role warnings. */
function report(p) {
  const unmapped = [...p.rows.keys()].filter((key) => !p.documented.has(key)).sort(byteCompare)
  const stale = [...p.rows.keys()]
    .filter((key) => {
      const had = p.documented.get(key)
      const row = p.rows.get(key)
      return had !== undefined && (had.layer !== row.layer || had.role !== row.role || had.exports !== row.exports)
    })
    .sort(byteCompare)
  const layoutDrift = unmapped.length + p.obsolete.length + stale.length === 0 && p.generatedInner !== currentInner(p.docText, p.markers)
  return { unmapped, obsolete: p.obsolete, stale, layoutDrift, notes: p.notes, drift: unmapped.length + p.obsolete.length + stale.length > 0 || layoutDrift }
}

function findingLines(r, doc) {
  return [
    ...r.unmapped.map((key) => `error: ${key}: undocumented module, run --write`),
    ...r.obsolete.map((key) => `error: ${key}: obsolete entry, module no longer exists`),
    ...r.stale.map((key) => `error: ${key}: stale entry, run --write`),
    ...(r.layoutDrift ? [`error: ${doc}: table layout differs from generated output, run --write`] : []),
    ...r.notes.map((note) => `warning: ${note}`),
  ]
}

/** The skill's JSON object: fixed key order, compact. The layer, cycle and side-effect arrays are always empty here. */
function jsonReport(r) {
  return JSON.stringify({
    curated_at_risk: r.notes,
    layer_violations: [],
    layout_drift: r.layoutDrift,
    obsolete: r.obsolete,
    side_effects: [],
    stale: r.stale,
    static_cycles: [],
    status: r.drift ? 'drift' : 'ok',
    unmapped: r.unmapped,
  })
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
  let staged = false
  let format = 'text'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check' || arg === '--write') {
      if (mode !== undefined && mode !== arg) throw new ArchDocError(`conflicting argument ${JSON.stringify(arg)}\n${USAGE}`)
      mode = arg
    } else if (arg === '--staged') {
      staged = true
    } else if (arg === '--format' || arg.startsWith('--format=')) {
      const value = arg === '--format' ? argv[++i] : arg.slice('--format='.length)
      if (value === undefined || value === '') throw new ArchDocError(`--format requires a value\n${USAGE}`)
      if (value !== 'text' && value !== 'json') throw new ArchDocError(`--format must be text or json, got ${JSON.stringify(value)}\n${USAGE}`)
      format = value
    } else {
      throw new ArchDocError(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`)
    }
  }
  const resolved = mode === '--check' ? 'check' : 'write'
  if (format === 'json' && resolved !== 'check') throw new ArchDocError(`--format json applies only to --check\n${USAGE}`)
  if (staged && resolved !== 'check') throw new ArchDocError(`--staged applies only to --check\n${USAGE}`)
  return { mode: resolved, staged, format }
}

/** Under --staged a config that exists only on disk would silently fall back to the defaults; refuse and say to stage it. */
function assertConfigStaged(root, index) {
  if (CONFIG_CANDIDATES.some((name) => index.configReader.has(name))) return
  const unstaged = CONFIG_CANDIDATES.find((name) => existsOnDisk(root, name))
  if (unstaged !== undefined) throw new ArchDocError(`${unstaged}: config exists in the working tree but not in the index; stage it with git add`)
}

/** Runs the engine from `cwd` and returns the exit code: 0 in sync or written, 1 drift, 2 configuration or usage error. Findings go through `stderr`, one line each; `stdout` receives only the `--format=json` object. */
export function runCli(argv, { cwd = process.cwd(), stderr = (line) => process.stderr.write(`${line}\n`), stdout = (line) => process.stdout.write(`${line}\n`) } = {}) {
  try {
    const args = parseArgs(argv)
    const root = repoRoot(cwd)
    const source = args.staged ? indexSource(root) : worktreeSource(root)
    if (args.staged) assertConfigStaged(root, source)
    const config = loadConfig(source.configReader)
    const p = plan(root, config, source)
    if (args.mode === 'check') {
      const r = report(p)
      if (args.format === 'json') stdout(jsonReport(r))
      else for (const line of findingLines(r, config.doc)) stderr(line)
      return r.drift ? 1 : 0
    }
    for (const note of p.notes) stderr(`info: ${note}`)
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

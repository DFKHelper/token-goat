#!/usr/bin/env node
/**
 * Derive a hook-input *shape manifest* from a harness's installed TypeScript declarations.
 *
 * Why a derived manifest instead of vendoring the .d.ts itself: the harness's declaration file is
 * the vendor's proprietary source (Copilot's `copilot-sdk/types.d.ts` carries no license grant, and
 * this repo is PolyForm Noncommercial). Copying it in would be a licensing problem. What this repo
 * actually needs is not their prose or their file -- it is the set of field names, types, and
 * optionality on the hook input interfaces, so a test can assert that the bridge forwards every
 * REQUIRED field. That set is extracted here and pinned as JSON; no vendor source is redistributed.
 *
 * The manifest exists to break a specific recurring defect: the repo restates its belief about a
 * harness's wire format in a fixture, the belief is wrong, and the fixture agrees with the bug, so
 * the cell goes green while the feature is dead. A manifest read out of the harness's own
 * declarations is not a belief. Copilot's `PostToolUseFailureHookInput.error` was declared required
 * from 1.0.76 onward while the shim silently dropped it for an entire release.
 *
 * Deliberately a small line-oriented parser rather than a TypeScript AST pass: it runs against a
 * file this repo does not own and cannot test in CI (the harness may not be installed), so its
 * failure mode must be "recognizes nothing and says so", never "half-parses and quietly reports a
 * short field list" -- a short list would silently weaken the very check this exists to make.
 * `--check` therefore fails on an empty extraction rather than treating it as agreement.
 *
 * Usage:
 *   node scripts/extract_harness_schema.mjs <path-to-types.d.ts> --harness copilot_cli \
 *     [--version 1.0.80] [--out schemas/copilot_cli.hooks.json] [--check]
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** Interfaces whose names end in this are the hook payload shapes we care about. */
const HOOK_INPUT_SUFFIX = 'HookInput'

/**
 * Pull `export interface <Name> [extends <Base>] { ... }` blocks out of a declaration file.
 *
 * Brace depth is tracked rather than matching a bare `}` at column 0, because a nested object-typed
 * field (`foo: { a: string }`) would otherwise close the interface early and truncate the field
 * list -- the silent-undercount failure this parser must not have.
 */
export function extractInterfaces(source) {
  const out = {}
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const header = /^export interface (\w+)(?:\s+extends\s+([\w, ]+?))?\s*\{/.exec(lines[i])
    if (!header) continue
    const [, name, ext] = header
    if (!name.endsWith(HOOK_INPUT_SUFFIX)) continue

    const fields = {}
    let depth = 1
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      const line = lines[j]
      // Count this line's net brace delta BEFORE deciding whether to read a field off it, so a
      // field declared on the interface's closing line is still seen and a nested block is skipped.
      const opens = (line.match(/\{/g) ?? []).length
      const closes = (line.match(/\}/g) ?? []).length
      if (depth === 1) {
        const field = /^\s*(?:readonly\s+)?(\w+)(\?)?\s*:\s*(.+?);\s*$/.exec(line)
        if (field) {
          const [, fname, optional, type] = field
          fields[fname] = { type: type.trim(), optional: optional === '?' }
        }
      }
      depth += opens - closes
    }
    out[name] = {
      extends: ext ? ext.split(',').map((s) => s.trim()).filter(Boolean) : [],
      fields,
    }
  }
  return out
}

/** Flatten an interface's own fields with everything it inherits, nearest declaration winning. */
export function resolveFields(interfaces, name, seen = new Set()) {
  if (seen.has(name)) return {}
  seen.add(name)
  const entry = interfaces[name]
  if (!entry) return {}
  let acc = {}
  for (const base of entry.extends) acc = { ...acc, ...resolveFields(interfaces, base, seen) }
  return { ...acc, ...entry.fields }
}

function buildManifest(sourcePath, harness, version) {
  const source = fs.readFileSync(sourcePath, 'utf8')
  const interfaces = extractInterfaces(source)
  const resolved = {}
  for (const name of Object.keys(interfaces)) {
    if (name === `Base${HOOK_INPUT_SUFFIX}`) continue
    resolved[name] = resolveFields(interfaces, name)
  }
  return {
    harness,
    sourceVersion: version,
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    // Recorded as a basename only: the absolute path is the extracting machine's home directory,
    // which has no business in a checked-in file.
    sourceFile: path.basename(sourcePath),
    extractedInterfaces: Object.keys(interfaces).sort(),
    hooks: resolved,
  }
}

/**
 * Locate the newest installed Copilot CLI's declaration file, so the npm scripts need neither a
 * hard-coded version nor shell variable expansion (npm runs scripts through cmd.exe on Windows,
 * where `$LOCALAPPDATA` is not expanded at all and silently becomes a literal path segment).
 * Returns `{path, version}` or null when Copilot is not installed on this machine.
 */
export function findInstalledCopilotTypes(env = process.env) {
  const roots = [
    env['LOCALAPPDATA'] && path.join(env['LOCALAPPDATA'], 'copilot', 'pkg'),
    env['HOME'] && path.join(env['HOME'], '.local', 'share', 'copilot', 'pkg'),
  ].filter(Boolean)
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const platform of fs.readdirSync(root)) {
      const dir = path.join(root, platform)
      if (!fs.statSync(dir).isDirectory()) continue
      const versions = fs
        .readdirSync(dir)
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        // Numeric per-component sort: lexical ordering puts 1.0.9 above 1.0.80.
        .sort((a, b) => {
          const pa = a.split('.').map(Number)
          const pb = b.split('.').map(Number)
          return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
        })
      for (let i = versions.length - 1; i >= 0; i--) {
        const candidate = path.join(dir, versions[i], 'copilot-sdk', 'types.d.ts')
        if (fs.existsSync(candidate)) return { path: candidate, version: versions[i] }
      }
    }
  }
  return null
}

function main(argv) {
  const args = argv.slice(2)
  // A positional is an argument that is neither a flag nor the value immediately after one --
  // without the second condition, `--harness copilot_cli` alone would make "copilot_cli" the
  // source path and the script would try to read a file by that name.
  const flagValueIndexes = new Set(
    args.flatMap((a, i) => (a.startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--') ? [i + 1] : [])),
  )
  let sourcePath = args.find((a, i) => !a.startsWith('--') && !flagValueIndexes.has(i))
  let detectedVersion
  if (!sourcePath || sourcePath === 'auto') {
    const found = findInstalledCopilotTypes()
    if (!found) {
      // Not an error: a contributor without Copilot installed cannot regenerate the manifest, and
      // must not be blocked by that. The pinned manifest in schemas/ is the checked-in truth; this
      // script only refreshes it. Exit 0 so `--check` in a wrapper script is skippable.
      process.stdout.write('Copilot CLI not installed here; nothing to extract (pinned manifest left as-is)\n')
      process.exit(0)
    }
    sourcePath = found.path
    detectedVersion = found.version
  }
  const flag = (name) => {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? undefined : args[i + 1]
  }
  if (!sourcePath) {
    process.stderr.write('usage: extract_harness_schema.mjs <types.d.ts> --harness <name> [--version v] [--out f] [--check]\n')
    process.exit(2)
  }
  const harness = flag('harness') ?? 'unknown'
  const manifest = buildManifest(sourcePath, harness, flag('version') ?? detectedVersion ?? 'unknown')

  // An empty extraction means the declaration format moved out from under this parser. Reporting
  // "no fields" as agreement would turn the whole check into a no-op exactly when it matters most.
  if (Object.keys(manifest.hooks).length === 0) {
    process.stderr.write(`no ${HOOK_INPUT_SUFFIX} interfaces found in ${sourcePath} -- the declaration format changed, or this is the wrong file\n`)
    process.exit(1)
  }

  const outPath = flag('out')
  const json = JSON.stringify(manifest, null, 2) + '\n'
  if (args.includes('--check')) {
    if (!outPath || !fs.existsSync(outPath)) {
      process.stderr.write(`--check needs an existing --out manifest to compare against\n`)
      process.exit(1)
    }
    const pinned = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    const drifted = JSON.stringify(pinned.hooks) !== JSON.stringify(manifest.hooks)
    process.stdout.write(
      drifted
        ? `DRIFT: installed ${harness} hook shapes differ from ${outPath} (pinned ${pinned.sourceVersion}, installed ${manifest.sourceVersion})\n`
        : `OK: installed ${harness} hook shapes match ${outPath}\n`,
    )
    process.exit(drifted ? 1 : 0)
  }
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, json, 'utf8')
    process.stdout.write(`wrote ${outPath} (${Object.keys(manifest.hooks).length} hook inputs)\n`)
  } else {
    process.stdout.write(json)
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('extract_harness_schema.mjs')) {
  main(process.argv)
}

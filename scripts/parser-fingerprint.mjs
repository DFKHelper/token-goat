#!/usr/bin/env node
// Generate (or verify) src/parser_fingerprint.ts, the digest of token-goat's extraction logic.
//
// files.sha answers "has this file's content changed since we parsed it". Nothing answered "has
// what we extract from that content changed", so a parser change left every already-indexed
// unchanged file pinned to its old symbol set forever: `token-goat index` reported them skipped and
// they kept stale rows until someone happened to edit each one. Measured on a real index, 37 of 237
// source files disagreed with what the same binary produces from scratch, 180 surplus rows in all.
//
// Hashing the extraction sources rather than a hand-bumped constant is the point: a constant you
// have to remember to bump is exactly the thing that was already missing. The cost is that any edit
// to these files changes the digest, so the next bulk index reparses everything. That is the
// correct trade: a reparse costs time once, a silently wrong index costs correctness indefinitely.
//
// Usage:
//   node scripts/parser-fingerprint.mjs           regenerate the constant
//   node scripts/parser-fingerprint.mjs --check    exit 1 if the checked-in constant is stale
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src', 'parser_fingerprint.ts')

/** Every source that decides what a parse extracts: the driver plus every language adapter. */
function extractionSources() {
  const files = [path.join(ROOT, 'src', 'parser.ts')]
  const dir = path.join(ROOT, 'src', 'languages')
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) files.push(full)
    }
  }
  walk(dir)
  return files.sort()
}

export function computeFingerprint() {
  const h = createHash('sha256')
  for (const file of extractionSources()) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    // Normalise line endings before hashing. A Windows checkout with core.autocrlf=true holds the
    // same bytes as a Linux one only after that conversion, and a digest that disagreed between a
    // developer's machine and CI would fail the check test on one platform for no real reason.
    const text = fs.readFileSync(file, 'utf8').split('\r\n').join('\n')
    h.update(rel)
    h.update('\0')
    h.update(text)
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

function render(fingerprint) {
  return [
    '// GENERATED FILE -- do not edit by hand. Run `npm run parser:fingerprint` to regenerate.',
    '//',
    "// A digest of src/parser.ts and src/languages/**, stamped into files.parser_sha alongside the",
    '// content sha every time a file is indexed. The freshness gates treat a mismatch as changed, so',
    '// an extraction-logic change invalidates already-indexed files whose content never moved. Before',
    '// this existed those files kept their old symbols indefinitely, because content was the only key.',
    `export const PARSER_FINGERPRINT = '${fingerprint}'`,
    '',
  ].join('\n')
}

// Only act when run as a command. The guard exists so a test can import computeFingerprint without
// the import itself rewriting a source file or calling process.exit out from under the runner.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

const fingerprint = invokedDirectly ? computeFingerprint() : ''
const wanted = render(fingerprint)

if (!invokedDirectly) {
  // Imported for computeFingerprint alone; nothing to do.
} else if (process.argv.includes('--check')) {
  const actual = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\r\n').join('\n') : ''
  if (actual !== wanted) {
    process.stderr.write(
      'src/parser_fingerprint.ts is stale: the extraction sources changed since it was generated.\n' +
        `Expected PARSER_FINGERPRINT = '${fingerprint}'.\n` +
        'Run `npm run parser:fingerprint`, and say in the CHANGELOG that upgrading reindexes.\n',
    )
    process.exit(1)
  }
  process.stdout.write(`parser fingerprint up to date (${fingerprint})\n`)
} else {
  fs.writeFileSync(OUT, wanted)
  process.stdout.write(`wrote src/parser_fingerprint.ts (${fingerprint})\n`)
}

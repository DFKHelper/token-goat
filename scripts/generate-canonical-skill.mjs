#!/usr/bin/env node
// Generate (or verify) src/canonical_skill.ts, the gzip+base64 blob of src/canonical_skill.md that `token-goat install` writes to ~/.claude/skills/token-goat/SKILL.md. The blob is unreadable, so with no generator the only editable copy was an installed one, and the next install overwrote edits made there. Usage: no argument rewrites the blob, `--check` exits 1 when it does not decode to the .md, `--help` prints the usage; any other argument exits 2 having written nothing.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'src', 'canonical_skill.md')
const OUT = path.join(ROOT, 'src', 'canonical_skill.ts')
const CHUNK = 120

const BLOB_RE = /const CANONICAL_SKILL_GZIP_BASE64 =\n([\s\S]*?)\n\n/

function readNormalized(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\r\n').join('\n') : ''
}

/** The base64 the generated file carries, or null when it has no blob in the shape render() writes. */
function extractBlob(text) {
  const m = BLOB_RE.exec(text)
  if (!m) return null
  return [...m[1].matchAll(/"([A-Za-z0-9+/=]*)"/g)].map((s) => s[1]).join('')
}

/** What a blob decodes to, or null when it does not decode at all. */
function decodeBlob(blob) {
  try {
    return gunzipSync(Buffer.from(blob, 'base64')).toString('utf8')
  } catch {
    return null
  }
}

function render(blob) {
  const chunks = blob.match(new RegExp(`.{1,${CHUNK}}`, 'g')) ?? ['']
  return [
    '// Generated from src/canonical_skill.md by scripts/generate-canonical-skill.mjs (`npm run skill:canonical`): edit the .md and regenerate, never this file.',
    "import { gunzipSync } from 'node:zlib'",
    '',
    '// Keep the canonical document out of the eagerly loaded startup bundle.',
    'const CANONICAL_SKILL_GZIP_BASE64 =',
    chunks.map((c) => `  "${c}"`).join(' +\n'),
    '',
    "export const CANONICAL_SKILL_MD = gunzipSync(Buffer.from(CANONICAL_SKILL_GZIP_BASE64, 'base64')).toString('utf8')",
    '',
  ].join('\n')
}

/** The text src/canonical_skill.ts decodes to, or null when it carries no decodable blob. Exported for the test that checks a regenerated copy. */
export function decodeGeneratedFile() {
  const blob = extractBlob(readNormalized(OUT))
  return blob === null ? null : decodeBlob(blob)
}

// Compared by decoded content, never by blob bytes: gzip writes the host OS into its header, so the same .md compresses to a different blob on Windows than on Linux and a byte comparison would fail on one of them.
function isCurrent(onDisk, source) {
  const blob = extractBlob(onDisk)
  return blob !== null && decodeBlob(blob) === source && onDisk === render(blob)
}

const realOrResolved = (p) => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}
const invokedDirectly =
  process.argv[1] !== undefined &&
  realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))

const USAGE = [
  'usage: node scripts/generate-canonical-skill.mjs [--check | --help]',
  '  (no argument)  regenerate src/canonical_skill.ts from src/canonical_skill.md',
  '  --check        exit 1 if src/canonical_skill.ts does not decode to src/canonical_skill.md',
  '  --help         print this usage',
  '',
].join('\n')

const args = invokedDirectly ? process.argv.slice(2) : []
const mode = args.length === 0 ? 'write' : args.length > 1 ? 'unknown' : args[0] === '--check' ? 'check' : args[0] === '--help' || args[0] === '-h' ? 'help' : 'unknown'

if (!invokedDirectly) {
  // Imported for decodeGeneratedFile alone; nothing to do.
} else if (mode === 'help') {
  process.stdout.write(USAGE)
} else if (mode === 'unknown') {
  process.stderr.write(`unknown argument: ${args.join(' ')}\n${USAGE}`)
  process.exit(2)
} else if (!fs.existsSync(SOURCE)) {
  process.stderr.write('src/canonical_skill.md is missing: it is the source src/canonical_skill.ts is generated from.\n')
  process.exit(1)
} else {
  const source = fs.readFileSync(SOURCE, 'utf8')
  const onDisk = readNormalized(OUT)
  if (mode === 'check') {
    if (!isCurrent(onDisk, source)) {
      process.stderr.write('src/canonical_skill.ts is stale: it does not decode to src/canonical_skill.md.\nRun `npm run skill:canonical`.\n')
      process.exit(1)
    }
    process.stdout.write('src/canonical_skill.ts is up to date with src/canonical_skill.md\n')
  } else if (isCurrent(onDisk, source)) {
    process.stdout.write('src/canonical_skill.ts is already up to date; nothing written\n')
  } else {
    // An existing blob that already decodes to the source is kept, so a run that only repairs the surrounding text does not churn the blob between platforms.
    const existing = extractBlob(onDisk)
    const blob = existing !== null && decodeBlob(existing) === source ? existing : gzipSync(Buffer.from(source, 'utf8'), { level: 9 }).toString('base64')
    fs.writeFileSync(OUT, render(blob))
    process.stdout.write('wrote src/canonical_skill.ts\n')
  }
}

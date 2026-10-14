/** Write src/fence_confusables.ts: what each look-alike reads as, for the fence-marker scans in src/injection_scan.ts, from Unicode's own confusables data (UTS #39) rather than a list someone wrote out. Only the entries whose prototype reads as a character those scans spell or match are kept: an ASCII letter or digit, `-`, `/`, `\`, `<`, `>`, `[`, `]` or `:`. `--extract <confusables.txt>` takes the full upstream file and writes those lines, unchanged, to scripts/data/confusables-fence.txt under the upstream header, recording the file's SHA-256 so the extract can be traced to it. With no argument the table is written from that extract, and `--check` fails when the written table is out of date. Run with `--extract` when a new Unicode version is published, then with no argument. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const EXTRACT_FILE = path.join(ROOT, 'scripts', 'data', 'confusables-fence.txt')
export const TABLE_FILE = path.join(ROOT, 'src', 'fence_confusables.ts')

/** The characters a reading may be made of: the scans compare against nothing else. */
const READABLE = /^[a-z0-9\-/\\<>[\]:]+$/

/** The punctuation the scans find with a character class rather than by spelling, each written out as every code point that reads as it. */
const CLASS_CHARS = ['<', '>', '/', '\\', '[']

/** Look-alikes the fence audits found getting through that UTS #39 does not list, or lists as something no marker spells: the CJK and mathematical angle brackets, the lenticular, white and tortoise-shell square brackets (the data puts the last with `(`), the dashes it chains to the katakana prolonged sound mark, the Greek `ν` and Cyrillic `п` read as `n` (the data has `v` for the first and nothing for the second), and the small capitals `ᴛ` and `ɢ`. Each is pinned by a test of the forgery it closed. */
const SUPPLEMENT = [
  ['<', [0x3008, 0x27e8]],
  ['>', [0x3009, 0x27e9]],
  ['[', [0x3010, 0x27e6, 0x3014]],
  [']', [0x3011, 0x27e7, 0x3015]],
  ['-', [0x2014, 0x2015, 0x2500, 0x30fc]],
  ['n', [0x3bd, 0x43f]],
  ['t', [0x1d1b]],
  ['g', [0x262]],
]

/** What a reader takes `text` for once decomposed: compatibility decomposition, accents dropped, lower case. */
function decomposed(text) {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

/** The data lines of the extract or the upstream file whose prototype is readable, as [code point, reading] pairs. */
export function parseEntries(text) {
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9A-F]{4,6}) ;\t([0-9A-F]{4,6}(?: [0-9A-F]{4,6})*) ;\tMA\b/.exec(line)
    if (m === null) continue
    const reading = decomposed(m[2].split(' ').map((hex) => String.fromCodePoint(parseInt(hex, 16))).join(''))
    if (reading.length > 0 && READABLE.test(reading)) entries.push([parseInt(m[1], 16), reading])
  }
  return entries
}

/** `cps`, sorted, as base-36 gaps from the one before, the first from zero. */
function encodeCodePoints(cps) {
  let prev = 0
  return [...cps].sort((a, b) => a - b).map((cp) => {
    const gap = (cp - prev).toString(36)
    prev = cp
    return gap
  }).join(',')
}

/** `groups` (reading to code points) as `reading gaps` joined by `|`, readings in order. */
function encodeGroups(groups) {
  return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([reading, cps]) => `${reading} ${encodeCodePoints(cps)}`).join('|')
}

/** The table module for the extract `text`. */
export function renderTable(text) {
  const version = /^# Version: (.+)$/m.exec(text)?.[1] ?? 'unknown'
  const readings = new Map()
  const ascii = new Map()
  const classes = new Map(CLASS_CHARS.map((ch) => [ch, new Set()]))
  for (const [cp, reading] of parseEntries(text)) {
    if (cp < 0x80) {
      // A single ASCII character for another: `0` for `o`, `1`, `I` and `|` for `l`. `m` reads as `rn` in the data, and no marker spells `rn`.
      if (reading.length === 1) ascii.set(cp, reading)
      continue
    }
    if (classes.has(reading)) classes.get(reading).add(cp)
    // Compatibility decomposition already reads it so wherever it is applied; the scans decompose every code point in their folding ranges, and a test proves the entries outside them are in this table.
    if (decomposed(String.fromCodePoint(cp)) !== reading) readings.set(cp, reading)
  }
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const reading = decomposed(String.fromCodePoint(cp))
    if (classes.has(reading)) classes.get(reading).add(cp)
  }
  for (const [reading, cps] of SUPPLEMENT) {
    for (const cp of cps) {
      readings.set(cp, reading)
      if (classes.has(reading)) classes.get(reading).add(cp)
    }
  }
  const byReading = new Map()
  for (const [cp, reading] of readings) byReading.set(reading, [...(byReading.get(reading) ?? []), cp])
  const asciiPairs = [...ascii].sort(([a], [b]) => a - b).map(([cp, reading]) => String.fromCharCode(cp) + reading).join('')
  return [
    `/** What a look-alike reads as, for the fence-marker scans in src/injection_scan.ts. Generated by scripts/generate-fence-confusables.mjs from scripts/data/confusables-fence.txt, the entries of Unicode's confusables data (UTS #39, version ${version}) whose prototype reads as an ASCII letter or digit, \`-\`, \`/\`, \`\\\`, \`<\`, \`>\`, \`[\`, \`]\` or \`:\`, plus the look-alikes the generator's SUPPLEMENT names; edit those, not this file. Each string holds groups joined by \`|\`, a reading then the code points that read as it, as base-36 gaps from the one before. */`,
    '',
    `/** Every non-ASCII code point whose reading compatibility decomposition does not already give. */`,
    `export const CONFUSABLE_READINGS = ${JSON.stringify(encodeGroups(byReading))}`,
    '',
    `/** Every non-ASCII code point that reads as one of the punctuation characters the scans match with a class, whether the data or compatibility decomposition says so. */`,
    `export const CONFUSABLE_CLASSES = ${JSON.stringify(encodeGroups([...classes].map(([ch, cps]) => [ch, [...cps]])))}`,
    '',
    `/** ASCII characters the data reads as another, as pairs: the character, then its reading. */`,
    `export const ASCII_CONFUSABLES = ${JSON.stringify(asciiPairs)}`,
    '',
  ].join('\n')
}

/** The extract of the upstream file `text`: its header, a line naming its digest, and every readable data line unchanged. */
export function renderExtract(text) {
  const lines = text.split(/\r?\n/)
  const header = []
  for (const line of lines) {
    if (!line.startsWith('#')) break
    header.push(line)
  }
  const kept = new Set(parseEntries(text).map(([cp]) => cp))
  const data = lines.filter((line) => {
    const m = /^([0-9A-F]{4,6}) ;/.exec(line)
    return m !== null && kept.has(parseInt(m[1], 16))
  })
  const digest = createHash('sha256').update(text).digest('hex')
  return [...header, `# Extract: the ${data.length} entries whose prototype reads as an ASCII letter or digit, -, /, \\, <, >, [, ] or :, from the upstream file with SHA-256 ${digest}.`, '#', ...data, ''].join('\n')
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const extractAt = args.indexOf('--extract')
  if (extractAt !== -1) {
    const upstream = args[extractAt + 1]
    if (upstream === undefined) throw new Error('--extract needs the path of the upstream confusables.txt')
    writeFileSync(EXTRACT_FILE, renderExtract(readFileSync(upstream, 'utf8')))
  }
  const table = renderTable(readFileSync(EXTRACT_FILE, 'utf8'))
  if (args.includes('--check')) {
    if (readFileSync(TABLE_FILE, 'utf8').replace(/\r\n/g, '\n') !== table) {
      console.error(`${path.relative(ROOT, TABLE_FILE)} is out of date: run node scripts/generate-fence-confusables.mjs`)
      process.exit(1)
    }
  } else {
    writeFileSync(TABLE_FILE, table)
  }
}

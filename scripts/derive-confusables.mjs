// Derives the look-alike table src/injection_scan.ts ships from Unicode confusables.txt (UTS #39). Usage: node scripts/derive-confusables.mjs <confusables.txt> [--write] -- filters the full file down to the rows tests/fixtures/confusables_targets.txt holds, prints the table, and with --write rewrites that fixture and the CONFUSABLE_ENTRIES line in src/injection_scan.ts.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMainModule } from './is-main-module.mjs'

/** The words whose letters the matcher must see through: the spoken markers and every fence tag name. Kept here so the derivation and its freshness test read one list. */
export const TARGET_WORDS = ['token-goat', 'tg', 'untrusted-web-content', 'untrusted-file-content', 'untrusted-image-text', 'untrusted-tool-output', 'untrusted-github-content', 'untrusted-html-content']
/** The punctuation the markers and tags are made of. */
export const TARGET_PUNCTUATION = '-[]<>/:'

/** Every character a look-alike may stand for: both cases of each letter in {@link TARGET_WORDS}, plus the punctuation. */
export function targetCharacters() {
  const out = new Set(TARGET_PUNCTUATION)
  for (const c of TARGET_WORDS.join('')) {
    out.add(c.toLowerCase())
    out.add(c.toUpperCase())
  }
  return out
}

/** The data rows of confusables.txt whose source is one non-ASCII code point and whose target is one character of {@link targetCharacters}. A row is kept verbatim up to the comment. */
export function filterRows(fullText) {
  const targets = targetCharacters()
  const rows = []
  for (const line of fullText.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    const [src, dst] = line.split(';').map((s) => s.trim())
    if (src === undefined || dst === undefined || src.includes(' ') || dst.includes(' ')) continue
    if (parseInt(src, 16) < 0x80 || !targets.has(String.fromCodePoint(parseInt(dst, 16)))) continue
    rows.push(`${src} ; ${dst}`)
  }
  return rows
}

/** What NFKD with the combining marks dropped makes of one character: the fold the matcher applies to a code point the table does not list, so the table needs no entry where this already gives the target. */
export function normalizationFold(ch) {
  return ch.normalize('NFKD').replace(/[\p{Mn}\p{Me}\p{Mc}]/gu, '')
}

/** The shipped table, built from filtered fixture rows sorted by code point and leaving out each look-alike that {@link normalizationFold} already maps to its target. Each entry is the target character followed by the decimal distance from the previous entry's code point (the first from 0); the targets are never digits, so entries need no separator. */
export function deriveEntries(rows) {
  let previous = 0
  return rows
    .map((r) => r.split(';').map((s) => s.trim()))
    .map(([src, dst]) => [parseInt(src, 16), String.fromCodePoint(parseInt(dst, 16))])
    .filter(([code, ch]) => normalizationFold(String.fromCodePoint(code)) !== ch)
    .sort((a, b) => a[0] - b[0])
    .map(([code, ch]) => {
      const entry = `${ch}${code - previous}`
      previous = code
      return entry
    })
    .join('')
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE_PATH = path.join(HERE, '..', 'tests', 'fixtures', 'confusables_targets.txt')
export const SOURCE_PATH = path.join(HERE, '..', 'src', 'injection_scan.ts')
export const ENTRIES_PREFIX = 'export const CONFUSABLE_ENTRIES = '

if (isMainModule(import.meta.url)) {
  const input = process.argv[2]
  if (input === undefined) throw new Error('usage: node scripts/derive-confusables.mjs <confusables.txt> [--write]')
  const rows = filterRows(fs.readFileSync(input, 'utf8'))
  const entries = deriveEntries(rows)
  console.log(`${rows.length} rows, ${entries.length} bytes of entries`)
  if (process.argv.includes('--write')) {
    fs.writeFileSync(FIXTURE_PATH, rows.join('\n') + '\n')
    const src = fs.readFileSync(SOURCE_PATH, 'utf8')
    const next = src.replace(new RegExp(`^${ENTRIES_PREFIX}.*$`, 'm'), () => `${ENTRIES_PREFIX}${JSON.stringify(entries)}`)
    if (next === src && !src.includes(JSON.stringify(entries))) throw new Error(`no ${ENTRIES_PREFIX} line in ${SOURCE_PATH}`)
    fs.writeFileSync(SOURCE_PATH, next)
  }
}

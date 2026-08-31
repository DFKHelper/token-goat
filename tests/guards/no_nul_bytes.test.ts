/**
 * Guard against raw NUL (U+0000) bytes in TypeScript source.
 *
 * A literal NUL in a `.ts` file makes ripgrep, grep, and token-goat classify the
 * whole file as binary and skip it in content search — silently blinding every
 * surgical-read and grep path for that file. parser.ts once carried a raw NUL in
 * a refs dedup key (`${callee}\0${line}`) where the two-character `\0` escape
 * was intended; the runtime string is identical but the source must stay text.
 * This guard scans both src/ and tests/ so any future stray NUL fails CI -- a test file
 * (tests/hooks_write.test.ts once carried a raw NUL in a "bogus null-byte path" fixture,
 * the same two-character-escape mistake) is just as blinded to grep/token-goat as shipped code.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOTS = [path.join(HERE, '..', '..', 'src'), path.join(HERE, '..', '..', 'tests')]

/** Every `.ts` file under dir, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...tsFiles(full))
    else if (ent.isFile() && ent.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * Control bytes that must never appear raw in source, as a set of byte values. Tab (0x09), LF
 * (0x0A) and CR (0x0D) are excluded because they are ordinary source formatting.
 *
 * Widened from NUL alone after a raw backspace (0x08) landed inside a regex literal in
 * tests/guards/truncation_invariant_holds.test.ts: a `\b` word-boundary written through a
 * generation step lost one backslash, and the surviving two characters was interpreted as the backspace
 * character rather than the two-character escape. The regex then required a literal 0x08 in its
 * input and matched nothing -- the guard it belonged to went green while checking a condition no
 * real output could satisfy. Byte-for-byte the same failure NUL causes: an invisible character
 * that changes meaning, that grep and code review both read straight past.
 */
const FORBIDDEN = new Set([...Array.from({ length: 32 }, (_, i) => i), 127].filter((c) => c !== 0x09 && c !== 0x0a && c !== 0x0d))

/** Human-readable name for the offending byte, so a failure says what to look for. */
function describeByte(code: number): string {
  if (code === 0) return 'NUL (U+0000)'
  if (code === 0x08) return 'BACKSPACE (0x08) -- a lone `\b` that should be an escape'
  if (code === 0x1b) return 'ESC (0x1b) -- write ANSI fixtures as \x1b escapes'
  return `control byte 0x${code.toString(16).padStart(2, '0')}`
}

describe('source files contain no raw control bytes', () => {
  it('no src/**/*.ts or tests/**/*.ts file contains a raw control byte', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      // Pinned per root: the walk swallows a missing directory as an empty one, so a moved src/ or
      // tests/ would leave this reporting "no NUL bytes found" having opened no files.
      const scanned = pinnedPopulation({
        what: `${path.basename(root)}/**/*.ts files`,
        items: tsFiles(root),
        floor: 100,
      })
      for (const f of scanned) {
        const buf = fs.readFileSync(f)
        // Reported with the byte and its line, because the whole point is that you cannot see it.
        for (let i = 0; i < buf.length; i++) {
          if (!FORBIDDEN.has(buf[i] as number)) continue
          const line = buf.subarray(0, i).toString('utf8').split('\n').length
          offenders.push(`${path.relative(path.join(HERE, '..', '..'), f)}:${line} contains ${describeByte(buf[i] as number)}`)
          break
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

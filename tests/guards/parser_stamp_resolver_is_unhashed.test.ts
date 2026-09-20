/** parserFingerprintForLanguage only reads back which digest an already-indexed row should carry. It decides nothing about what a parse extracts or how a file's bytes become chunk text, so it must not live in a file either fingerprint hashes -- and it did, for one commit: it was added to src/parser_types.ts, which embedFingerprintSources() hashes whole, and the embed digest moved from b7b2ff71de288d13 to 08d8101c9bce353e. That would have re-embedded every already-indexed file on upgrade (17,855 of them on one real index measured here), the expensive half of indexing, for a pure map lookup. This guard pins the property rather than either digest's current value: wherever the resolver is defined, that file must be outside both hashed sets. */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { embedFingerprintSources, extractionSources } from '../../scripts/parser-fingerprint.mjs'
import { pinnedPopulation } from './population.js'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

const relative = (f: string): string => path.relative(ROOT, f).split(path.sep).join('/')

/** FORMAT-DERIVED: the exported-function declaration form is TypeScript's own syntax (https://www.typescriptlang.org/docs/handbook/2/modules.html), not a shape read off this repo's code. The only borrowed token is the symbol name itself, and the non-vacuity assertion below turns a stale name into a failure rather than a silent pass. */
const DECLARATION = /^export function parserFingerprintForLanguage\b/m

/** Every .ts file under src/, pinned so a broken walk cannot report "the resolver is nowhere hashed" by having scanned nothing. The anchor names parser_types.ts, the file the resolver was wrongly added to, since a walk that stopped reaching it would go green with the defect restored. */
function srcTypeScriptFiles(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) found.push(relative(full))
    }
  }
  walk(SRC)
  return pinnedPopulation({ what: 'TypeScript modules under src/', items: found.sort(), floor: 330, ceiling: 430, mustIncludeExact: ['src/parser_types.ts'] })
}

function srcFilesDefining(pattern: RegExp): string[] {
  return srcTypeScriptFiles().filter((f) => pattern.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
}

describe('the parser-stamp resolver lives outside every hashed fingerprint source', () => {
  it('is defined exactly once under src/, so this guard cannot pass because it found nothing', () => {
    expect(
      srcFilesDefining(DECLARATION),
      'no src/ file declares parserFingerprintForLanguage -- the symbol was renamed or removed, and every assertion below would have passed vacuously against an empty set',
    ).toHaveLength(1)
  })

  it('is not hashed by extractionSources() or embedFingerprintSources(), so editing a stamp lookup reparses and re-embeds nothing', () => {
    const extraction = new Set(extractionSources().map(relative))
    const embed = new Set(embedFingerprintSources().map(relative))
    for (const file of srcFilesDefining(DECLARATION)) {
      expect(
        embed.has(file),
        `${file} defines parserFingerprintForLanguage and is hashed into EMBED_FINGERPRINT, so every edit to a stamp lookup re-embeds every indexed file -- the expensive half of indexing, for a map lookup that decides nothing about chunk text`,
      ).toBe(false)
      expect(
        extraction.has(file),
        `${file} defines parserFingerprintForLanguage and is hashed into PARSER_FINGERPRINT, so every edit to a stamp lookup invalidates every indexed file's parse`,
      ).toBe(false)
    }
  })
})

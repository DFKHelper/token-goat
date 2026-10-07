// A zero-width or bidirectional-control character written raw into src cannot be seen in a review or a diff, so a regex or string that needs one spells it as a \u escape. Provenance: HAND-DERIVED, the ranges are Unicode's Format (Cf) characters that render as nothing: U+200B-200F, U+202A-202E, U+2060-2064, U+2066-2069 and U+FEFF.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(full)
    return e.isFile() && /\.(ts|mjs|js)$/.test(e.name) ? [full] : []
  })
}

describe('src source files', () => {
  it('hold no raw zero-width or bidirectional-control character', () => {
    const files = pinnedPopulation({ what: 'source files scanned for invisible characters', items: sourceFiles(SRC_DIR), floor: 450, mustInclude: ['import_export_extract.ts'] })
    const hits: string[] = []
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const text = i === 0 && line.startsWith('\uFEFF') ? line.slice(1) : line
        if (INVISIBLE.test(text)) hits.push(`${path.relative(SRC_DIR, file)}:${i + 1}`)
      })
    }
    expect(hits, 'write the character as a \\u escape so it shows in a diff').toEqual([])
  })
})

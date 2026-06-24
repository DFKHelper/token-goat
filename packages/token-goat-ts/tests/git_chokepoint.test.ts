import { readFileSync, readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(here, '..', 'src')

/** Recursively collect every .ts file under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

// Bare git-spawn patterns. runGit in util.ts is the single sanctioned site;
// anything matching these outside util.ts is a chokepoint violation.
const GIT_SPAWN_PATTERNS: RegExp[] = [
  /\bexec\(\s*['"`]git\b/,
  /\bspawn\(\s*['"`]git\b/,
  /\bexecSync\(\s*['"`]git\b/,
  /\bspawnSync\(\s*['"`]git\b/,
]

describe('git chokepoint', () => {
  it('no .ts file outside src/util.ts spawns git directly', () => {
    const utilPath = path.join(srcDir, 'util.ts')
    const violations: string[] = []

    for (const file of collectTsFiles(srcDir)) {
      if (path.resolve(file) === path.resolve(utilPath)) continue
      const content = readFileSync(file, 'utf-8')
      for (const pattern of GIT_SPAWN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(srcDir, file)} matches ${pattern}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

/**
 * Guard against architecture documentation drift.
 *
 * Enforces that CLAUDE.arch.md's Component Map is always 100% synchronized with
 * the actual source tree under src/.
 *
 * If this guard fails:
 *   Run `npm run docs:arch` to update CLAUDE.arch.md in place before committing.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  extractExistingDescriptions,
  scanSourceFiles,
  syncArchDocs,
  toPosixRel,
} from '../../scripts/sync-arch-docs.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARCH_DOC = path.join(ROOT, 'CLAUDE.arch.md')

describe('Architecture documentation freshness and coverage', () => {
  it('has zero drift according to syncArchDocs({ check: true })', () => {
    const res = syncArchDocs({ check: true })
    expect(res.ok).toBe(true)
    expect(res.count).toBeGreaterThan(0)
  })

  it('contains demarcation markers in CLAUDE.arch.md', () => {
    const content = fs.readFileSync(ARCH_DOC, 'utf8')
    expect(content).toContain('<!-- ARCH_COMPONENTS_START -->')
    expect(content).toContain('<!-- ARCH_COMPONENTS_END -->')
  })

  it('documents every TypeScript module in src/', () => {
    const rawDoc = fs.readFileSync(ARCH_DOC, 'utf8')
    const existing = extractExistingDescriptions(rawDoc)
    const sourceFiles = scanSourceFiles().map((f) => toPosixRel(f))

    const documented = new Set(existing.keys())
    const missing = sourceFiles.filter((f: string) => !documented.has(f))

    expect(
      missing,
      `The following ${missing.length} modules exist in src/ but are not in CLAUDE.arch.md. Run 'npm run docs:arch' to fix:\n` +
        missing.join('\n')
    ).toEqual([])
  })

  it('contains no dead links or deleted files in CLAUDE.arch.md', () => {
    const rawDoc = fs.readFileSync(ARCH_DOC, 'utf8')
    const existing = extractExistingDescriptions(rawDoc)
    const sourceFiles = new Set(scanSourceFiles().map((f) => toPosixRel(f)))

    const dead = [...existing.keys()].filter((f: string) => !sourceFiles.has(f))

    expect(
      dead,
      `The following ${dead.length} modules are listed in CLAUDE.arch.md but do not exist in src/. Run 'npm run docs:arch' to fix:\n` +
        dead.join('\n')
    ).toEqual([])
  })
})

/**
 * package.json declared `"license": "MIT"` while LICENSE, the README badge, and SECURITY.md all
 * said PolyForm Noncommercial 1.0.0. Every license scanner, SBOM generator, and legal review reads
 * the package.json field, so the published package told them it was permissive when it is not.
 * PolyForm Noncommercial has no SPDX identifier, so npm's documented form for that case is the
 * only correct value here.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function readText(name: string): string {
  return fs.readFileSync(path.join(repoRoot, name), 'utf8')
}

describe('declared license', () => {
  it('points at the LICENSE file rather than naming a licence the file does not grant', () => {
    const declared = (JSON.parse(readText('package.json')) as { license?: string }).license

    expect(declared).toBe('SEE LICENSE IN LICENSE')
  })

  it('ships the LICENSE file it points at', () => {
    const files = (JSON.parse(readText('package.json')) as { files?: string[] }).files ?? []

    expect(files).toContain('LICENSE')
  })

  it('still has PolyForm Noncommercial as the actual grant, so the pointer is not stale', () => {
    expect(readText('LICENSE')).toContain('PolyForm Noncommercial License 1.0.0')
  })

  it('says the same thing in SECURITY.md', () => {
    expect(readText('SECURITY.md')).toContain('PolyForm Noncommercial License 1.0.0')
  })
})

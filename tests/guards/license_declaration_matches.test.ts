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

  // The README links into SECURITY.md for the dependency-advisory disclosure. npm rewrites relative
  // links on its own page, but the tarball did not carry the file, so anyone reviewing the package
  // offline followed a link to nothing. It is a few kilobytes and it is the document they came for.
  it('ships SECURITY.md too, since the README sends the reader there', () => {
    const files = (JSON.parse(readText('package.json')) as { files?: string[] }).files ?? []

    expect(files).toContain('SECURITY.md')
    expect(readText('README.md')).toContain('SECURITY.md#dependency-advisories')
  })

  it('still has PolyForm Noncommercial as the actual grant, so the pointer is not stale', () => {
    expect(readText('LICENSE')).toContain('PolyForm Noncommercial License 1.0.0')
  })

  it('says the same thing in SECURITY.md', () => {
    expect(readText('SECURITY.md')).toContain('PolyForm Noncommercial License 1.0.0')
  })
})

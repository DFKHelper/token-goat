/**
 * This field has been wrong twice, in opposite directions. It first declared `MIT` while LICENSE,
 * the README badge, and SECURITY.md all said PolyForm Noncommercial 1.0.0, telling every scanner
 * the package was permissive when it is not. The correction then overshot to npm's
 * `SEE LICENSE IN <file>` form, on the belief that PolyForm Noncommercial has no SPDX identifier.
 * It has one: `PolyForm-Noncommercial-1.0.0` is on the SPDX license list, so the pointer form was
 * never the right value here. The difference matters to the reader this field exists for. A
 * declared SPDX identifier resolves to a known license and a scanner applies policy to it
 * automatically; the pointer form resolves to nothing and arrives as an unknown license needing
 * manual review, which is slower and more likely to end in a refusal by default. Being correctly
 * identified as noncommercial is the goal, not looking permissive.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The SPDX short identifier for the grant in LICENSE. Both manifests and both lockfiles say this. */
const SPDX_ID = 'PolyForm-Noncommercial-1.0.0'

const MANIFESTS = ['package.json', 'vscode-extension/package.json'] as const
const LOCKFILES = ['package-lock.json', 'vscode-extension/package-lock.json'] as const

function readText(name: string): string {
  return fs.readFileSync(path.join(repoRoot, name), 'utf8')
}

describe('declared license', () => {
  it.each(MANIFESTS.map((m) => [m]))('%s declares the SPDX identifier for the grant', (manifest) => {
    const declared = (JSON.parse(readText(manifest)) as { license?: string }).license

    expect(declared).toBe(SPDX_ID)
  })

  // Stated separately from the equality above so the reason survives a future edit to the constant.
  // npm documents the pointer form for a license that is not on the SPDX list, and this one is.
  it.each(MANIFESTS.map((m) => [m]))('%s does not fall back to the pointer form', (manifest) => {
    const declared = (JSON.parse(readText(manifest)) as { license?: string }).license ?? ''

    expect(declared, 'a scanner reads this as an unknown license needing manual review').not.toMatch(
      /^SEE LICENSE IN /,
    )
  })

  // A lockfile carries its own copy of the root package's license, and a scanner reads the lockfile
  // as readily as the manifest. Editing a manifest alone once left its lockfile behind.
  it.each(LOCKFILES.map((l) => [l]))('%s repeats the same declaration as its manifest', (lockPath) => {
    const lock = JSON.parse(readText(lockPath)) as { packages?: Record<string, { license?: string }> }

    expect(lock.packages?.['']?.license).toBe(SPDX_ID)
  })

  it.each(MANIFESTS.map((m) => [m]))('%s ships the LICENSE its declaration names', (manifest) => {
    const files = (JSON.parse(readText(manifest)) as { files?: string[] }).files ?? []

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

  // The supply-chain answer an evaluation asks for -- "how do I know this tarball came from that
  // repo" -- was true (the workflow publishes with --provenance) but written down nowhere. These
  // keep the claim and the workflow that backs it from drifting apart: a publish step that loses
  // --provenance leaves the document promising an attestation that no longer exists.
  it('documents provenance, and the publish workflow still produces it', () => {
    const security = readText('SECURITY.md')

    expect(security).toContain('npm audit signatures')
    expect(readText('.github/workflows/publish.yml')).toContain('--provenance')
  })

  it('does not claim provenance without the id-token permission that mints it', () => {
    expect(readText('.github/workflows/publish.yml')).toContain('id-token: write')
  })

  // The declaration is only right while it still names what the file grants. Both LICENSE files are
  // checked, because the extension ships its own copy.
  it.each([['LICENSE'], ['vscode-extension/LICENSE']])('%s still grants PolyForm Noncommercial 1.0.0', (file) => {
    expect(readText(file)).toContain('PolyForm Noncommercial License 1.0.0')
  })

  it('says the same thing in SECURITY.md', () => {
    expect(readText('SECURITY.md')).toContain('PolyForm Noncommercial License 1.0.0')
  })
})

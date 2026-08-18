/**
 * A license scan of this package is not the same question as `npm audit`, and it had never been
 * asked here. Asking it turned up three packages in the production tree carrying no license grant
 * at all -- `buffers@0.1.1` and `chainsaw@0.1.0` with neither a field nor a file, `traverse@0.3.9`
 * with the file but not the field. No grant is worse for a review than a copyleft grant, because
 * there is nothing to apply a policy to. All three arrived through one old `unzipper`, which an
 * override removes.
 *
 * What is left cannot be removed, so it has to be disclosed instead: seven packages whose
 * declaration no scanner can resolve, and fifteen carrying a copyleft term. This test is the thing
 * that keeps that disclosure true. It reads `package-lock.json` rather than `node_modules`, because
 * the lockfile lists every platform's packages while an install only holds one platform's -- a
 * `node_modules` sweep on Windows never sees the ten Linux and macOS libvips builds.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface LockEntry {
  license?: string
  dev?: boolean
}

function readText(name: string): string {
  return fs.readFileSync(path.join(repoRoot, name), 'utf8')
}

function productionPackages(): { name: string; license: string | undefined }[] {
  const lock = JSON.parse(readText('package-lock.json')) as { packages: Record<string, LockEntry> }
  return Object.entries(lock.packages)
    .filter(([lockPath, entry]) => lockPath !== '' && !entry.dev)
    .map(([lockPath, entry]) => ({ name: lockPath.replace(/^.*node_modules\//, ''), license: entry.license }))
}

/** `Apache` without the `-2.0` is not an SPDX identifier, so the whole expression resolves to nothing. */
function isUnresolvable(license: string | undefined): boolean {
  if (typeof license !== 'string' || !license.trim()) return true
  return /^SEE LICENSE IN/i.test(license) || /\bApache\b(?!-)/.test(license)
}

function isCopyleft(license: string | undefined): boolean {
  return typeof license === 'string' && /GPL|MPL|SSPL|EPL|CDDL/i.test(license)
}

/**
 * SECURITY.md names the platform families rather than all twenty-two packages, so a match is by
 * family. A flagged package outside every family is the case this test exists to catch: it means
 * something new needs an answer in the document.
 */
const FAMILIES: { match: RegExp; documentedAs: string }[] = [
  { match: /^@img\/sharp-libvips-/, documentedAs: '`@img/sharp-libvips-<platform>`' },
  { match: /^@img\/sharp-/, documentedAs: '`@img/sharp-<platform>`' },
  { match: /^sqlite-vec/, documentedAs: '`sqlite-vec`' },
  { match: /^flatbuffers$/, documentedAs: '`flatbuffers`' },
  { match: /^jszip$/, documentedAs: '`jszip`' },
]

describe('dependency licenses', () => {
  const packages = productionPackages()
  const flagged = packages.filter((p) => isUnresolvable(p.license) || isCopyleft(p.license))

  it('reads a real lockfile, so an empty sweep cannot pass as a clean one', () => {
    expect(packages.length).toBeGreaterThan(200)
    expect(flagged.length).toBeGreaterThan(10)
  })

  // The packages with no license grant at all. Named individually because these are the ones that
  // stop a review, and because the override that removes them is easy to drop by accident.
  it.each([['buffers'], ['chainsaw'], ['traverse'], ['binary'], ['fstream']])(
    '%s is not in the production tree',
    (name) => {
      expect(
        packages.map((p) => p.name),
        'this arrives through unzipper < 0.11 and carries no resolvable license grant',
      ).not.toContain(name)
    },
  )

  it('keeps the unzipper override that removed them', () => {
    const overrides = (JSON.parse(readText('package.json')) as { overrides?: Record<string, string> }).overrides ?? {}

    expect(overrides['unzipper']).toBeDefined()
    // 0.11 is the release that dropped `binary`. Anything that still allows 0.10 brings it back.
    expect(overrides['unzipper']).not.toMatch(/0\.10/)
  })

  it('has a documented family for every package a scan will flag', () => {
    const undocumented = flagged
      .filter((p) => !FAMILIES.some((f) => f.match.test(p.name)))
      .map((p) => `${p.name} [${p.license ?? 'no license field'}]`)

    expect(undocumented, 'SECURITY.md has to name this before a scan asks about it').toEqual([])
  })

  // Checked against the table rows, not the whole document. Every one of these names also appears
  // in the surrounding prose, so a plain `toContain` stayed green when a disclosure row was deleted.
  it.each(FAMILIES.map((f) => [f.documentedAs]))('SECURITY.md discloses %s in a table row', (documentedAs) => {
    const rows = readText('SECURITY.md')
      .split('\n')
      .filter((line) => line.startsWith('| '))

    expect(rows.some((row) => row.includes(documentedAs)), 'a mention in prose is not a disclosure').toBe(true)
  })

  // A family nobody matches is a stale row in the document, which reads as coverage it no longer has.
  it.each(FAMILIES.map((f) => [f.documentedAs, f.match]))('%s still matches something in the tree', (_label, match) => {
    expect(flagged.some((p) => (match as RegExp).test(p.name))).toBe(true)
  })

  it('says the whole set is optional, and the lockfile agrees', () => {
    const lock = JSON.parse(readText('package-lock.json')) as {
      packages: Record<string, { dev?: boolean; optional?: boolean }>
    }
    const notOptional = Object.entries(lock.packages)
      .filter(([lockPath, entry]) => lockPath !== '' && !entry.dev && !entry.optional)
      .map(([lockPath]) => lockPath.replace(/^.*node_modules\//, ''))
      .filter((name) => flagged.some((f) => f.name === name))

    expect(notOptional, 'SECURITY.md claims --omit=optional avoids all of these').toEqual([])
    expect(readText('SECURITY.md')).toContain('npm install --omit=optional token-goat')
  })
})

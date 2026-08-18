/**
 * SECURITY.md tells an evaluator that three packages carry the residual `npm audit` findings, and
 * that two of them are optional so an install can simply not have them. That claim is only true
 * while the manifest agrees. Promoting `@xenova/transformers` or `exceljs` to a required dependency
 * would silently turn a documented "you can opt out" into a lie, and no other test reads the
 * manifest for this. The two forward-patched majors are pinned here for the same reason: the
 * document says they were moved across a major to clear their advisories, so a revert must fail.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Manifest {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  overrides?: Record<string, string>
  scripts?: Record<string, string>
}

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Manifest
const security = fs.readFileSync(path.join(repoRoot, 'SECURITY.md'), 'utf8')

/** The floors npm's forward fixes landed on, so a downgrade back under one fails rather than passing quietly. */
function majorOf(range: string): number {
  return Number(/(\d+)\.\d+/.exec(range)?.[1] ?? -1)
}

function minorOf(range: string): number {
  return Number(/\d+\.(\d+)/.exec(range)?.[1] ?? -1)
}

describe('dependency advisory disclosure', () => {
  it('still has the section at all, so an empty sweep cannot pass as a clean one', () => {
    expect(security).toContain('## Dependency advisories')
  })

  it.each([['@xenova/transformers'], ['exceljs']])('keeps %s optional, which is what the document promises', (name) => {
    expect(Object.keys(pkg.optionalDependencies ?? {})).toContain(name)
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(name)
  })

  it('keeps html-to-text required, because the document says so rather than claiming an opt-out', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toContain('html-to-text')
  })

  it('names every package the table discusses, so a rename cannot orphan a row', () => {
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})])
    for (const name of ['@xenova/transformers', 'exceljs', 'html-to-text', 'sharp', 'puppeteer-core']) {
      expect(security, `${name} is discussed in SECURITY.md`).toContain(name)
      expect(declared, `${name} is still a dependency`).toContain(name)
    }
  })

  it('does not fall back below the versions that carry the forward fixes', () => {
    // sharp is pre-1.0, so its patched line is a minor bump; puppeteer-core's is a major.
    expect(minorOf(pkg.optionalDependencies?.['sharp'] ?? '')).toBeGreaterThanOrEqual(35)
    expect(majorOf(pkg.optionalDependencies?.['puppeteer-core'] ?? '')).toBeGreaterThanOrEqual(25)
  })
})

/**
 * The overrides clear the repository's own audit, and npm applies them only in the root project, so
 * an install of the published package does not get them. SECURITY.md now says that outright. These
 * pin both halves of the claim: dropping an override would make the repository dirty again while
 * the document still called it clean, and dropping the disclosure would let a clean repository scan
 * pass for a clean install.
 */
describe('override disclosure', () => {
  it.each([['protobufjs'], ['deepmerge-ts'], ['uuid'], ['sharp']])('still overrides %s', (name) => {
    expect(Object.keys(pkg.overrides ?? {})).toContain(name)
  })

  it('says overrides do not reach an installed copy, rather than leaving the gap implied', () => {
    expect(security).toContain('npm applies `overrides` only in the root project')
  })

  it('gives the reader the command that reproduces each of the three answers', () => {
    expect(security).toContain('npm audit --omit=dev --omit=optional')
    expect(security).toContain('npm install --omit=optional token-goat')
  })

  // The document points a bill-of-materials scanner at this script; an absent script would send
  // that reader to a command that does not exist.
  it('ships the sbom script SECURITY.md sends a scanner to', () => {
    expect(security).toContain('npm run sbom')
    expect(pkg.scripts?.['sbom']).toContain('cyclonedx')
  })

  // The reachability argument in the table is specific: two named call sites, both merging options.
  // If it ever softens back into a general "we do not merge page content", the specificity that
  // makes it checkable is gone.
  it('names the call sites that carry the html-to-text reachability argument', () => {
    expect(security).toContain('composeOptions')
    expect(security).toContain('mergeDuplicatesPreferLast')
  })

  it('records why html-to-text is not rolled back to drop deepmerge-ts', () => {
    expect(security).toContain('htmlparser2')
  })
})

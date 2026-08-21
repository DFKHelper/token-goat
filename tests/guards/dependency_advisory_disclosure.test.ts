/**
 * SECURITY.md tells an evaluator which packages carry the residual `npm audit` findings, that
 * `@xenova/transformers` is optional so an install can simply not have it, and that `exceljs` is
 * not installed at all any more. That claim is only true while the manifest agrees. Promoting
 * either one back into a shipped section
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
  devDependencies?: Record<string, string>
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

  it.each([['@xenova/transformers']])('keeps %s optional, which is what the document promises', (name) => {
    expect(Object.keys(pkg.optionalDependencies ?? {})).toContain(name)
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(name)
  })

  // exceljs went further than optional: the xlsx-* commands read the container directly with
  // fflate and fast-xml-parser now, so it is a test fixture writer and nothing else. That is what
  // takes the install tree from 301 packages to 246 and clears every deprecated package out of it,
  // so putting it back into either shipped section would quietly undo all of that while the
  // document still claimed it.
  it('keeps exceljs out of the packages a consumer installs', () => {
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('exceljs')
    expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain('exceljs')
    expect(Object.keys(pkg.devDependencies ?? {}), 'the tests still write fixtures with it').toContain('exceljs')
  })

  // The reverse of what this once asserted. html-to-text is inlined by esbuild at build time and
  // nothing in dist imports it, so keeping it in `dependencies` shipped deepmerge-ts, htmlparser2,
  // selderee and dom-serializer to every consumer for nothing. Moving it is what takes the
  // no-optional install to zero advisories, so a move back would silently reintroduce that chain.
  it('keeps html-to-text out of the packages a consumer installs', () => {
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('html-to-text')
    expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain('html-to-text')
    expect(Object.keys(pkg.devDependencies ?? {}), 'the build still needs it').toContain('html-to-text')
  })

  // The document now claims that install is clean rather than carrying one chain. The claim is
  // only worth making while nothing has been added back to `dependencies` that could break it.
  it('claims a clean no-optional install, and lists only packages that keep it clean', () => {
    expect(security).toContain('clean, 46 packages')
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(
      expect.arrayContaining(['better-sqlite3', 'commander', 'zod']),
    )
  })

  it('names every package the table discusses, so a rename cannot orphan a row', () => {
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})])
    for (const name of ['@xenova/transformers', 'sharp', 'puppeteer-core']) {
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

  // The html-to-text row used to carry a reachability argument for deepmerge-ts. The package is
  // gone from a consumer install now, so the document explains the removal instead -- including
  // why it beat the rollback we had considered, which is the part a reader would otherwise ask
  // about. Naming both packages keeps that explanation from decaying into "we removed it".
  it('explains the html-to-text removal rather than dropping the subject', () => {
    expect(security).toContain('deepmerge-ts')
    expect(security).toContain('htmlparser2')
    expect(security, 'the rollback alternative and why it lost').toContain('9.x')
  })
})

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

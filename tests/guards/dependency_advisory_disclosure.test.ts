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

  // The inverse of what this asserted until the embedding model became opt-in. Optional was not
  // good enough: npm installs optionalDependencies by default, so "optional" meant everyone got it,
  // and with it a critical protobufjs advisory, four more through onnxruntime-web, and a nested
  // older sharp carrying four libvips CVEs -- six in total, none patchable from here. Putting it
  // back into either shipped section reinstates all six silently, which is precisely why this reads
  // both sections rather than only the one it moved out of.
  it('keeps @xenova/transformers out of the packages a consumer installs', () => {
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@xenova/transformers')
    expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain('@xenova/transformers')
    expect(Object.keys(pkg.devDependencies ?? {}), 'the tests still embed with it').toContain('@xenova/transformers')
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
  // The count is the part worth pinning: the document states how large that install is, and five
  // packages the bundle inlines have since moved out of `dependencies`, which is what took it from
  // 46 to 40. The anchor names the two that stay because the bundle genuinely resolves them at run
  // time, so a demotion of either one fails here as well as in the bundle guard.
  it('claims a clean no-optional install, and lists only packages that keep it clean', () => {
    expect(security).toContain('clean, 40 packages')
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(
      expect.arrayContaining(['better-sqlite3', 'jsonc-parser']),
    )
  })

  it('names every package the table discusses, so a rename cannot orphan a row', () => {
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})])
    for (const name of ['sharp', 'puppeteer-core']) {
      expect(security, `${name} is discussed in SECURITY.md`).toContain(name)
      expect(declared, `${name} is still a dependency`).toContain(name)
    }
    // @xenova/transformers is the one the document discusses at length without shipping. It has to
    // stay named there, because the section is now largely about its absence and the command that
    // brings it back, and a silent rename would leave that whole passage pointing at nothing.
    expect(security).toContain('@xenova/transformers')
    expect(Object.keys(pkg.devDependencies ?? {})).toContain('@xenova/transformers')
    expect(declared).not.toContain('@xenova/transformers')
  })

  // The document does not merely say the model is optional; it prints the command that installs it.
  // A command that is wrong is worse than no command, and this one is easy to get wrong in a way
  // nobody notices: a global token-goat needs `-g` for the sibling to resolve, and a project
  // install must not have it. Both spellings are asserted because the document promises both.
  it('prints an install command for the model it no longer ships', () => {
    expect(security).toContain('npm install -g @xenova/transformers')
    expect(security).toMatch(/drop -g if token-goat is a project dependency/)
  })

  // Every advisory a consumer used to inherit came through that one package, so the document's
  // claim is now that a default install is clean rather than that some paths are unreachable. The
  // count is pinned for the same reason the no-optional count below it is: the document states a
  // number, and a number in a security document that nothing checks goes stale silently.
  it('claims a clean default install, not merely a clean no-optional one', () => {
    expect(security).toContain('clean, 106 packages')
    expect(security).toContain('clean, 40 packages')
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

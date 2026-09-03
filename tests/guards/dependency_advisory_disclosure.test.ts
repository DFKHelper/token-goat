/**
 * SECURITY.md tells an evaluator which packages carry the residual `npm audit` findings, that
 * `onnxruntime-node` is opt-in so an install can simply not have it, and that `exceljs` is
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

import { consumerPackageCount } from '../helpers/lock_tree.js'

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

/**
 * The size SECURITY.md claims for one of the two installs, read out of the table row that claims it.
 *
 * Read rather than matched. This guard used to assert that the string `clean, 106 packages` appeared
 * somewhere in the document, which cannot tell a current number from a stale one -- it is a fact
 * about the sentence. Pulling the number out and measuring against it is the whole point of the
 * change; finding the row is a precondition, so a row that has been deleted or reworded fails here
 * instead of quietly leaving nothing to check.
 */
function statedInstallSize(rowLabel: string): number {
  const row = security.split('\n').find((line) => line.startsWith(`| ${rowLabel} |`))
  if (!row) throw new Error(`SECURITY.md has no install table row labelled "${rowLabel}"`)
  const stated = /\bclean, (\d+) packages\b/.exec(row)
  if (!stated) throw new Error(`the "${rowLabel}" row no longer states a clean package count: ${row}`)
  return Number(stated[1])
}

describe('dependency advisory disclosure', () => {
  it('still has the section at all, so an empty sweep cannot pass as a clean one', () => {
    expect(security).toContain('## Dependency advisories')
  })

  // The inverse of what this asserted until the embedding model became opt-in. Optional was not
  // good enough: npm installs optionalDependencies by default, so "optional" meant everyone got it,
  // and with it a critical protobufjs advisory, four more through onnxruntime-web, and a nested
  // older sharp carrying four libvips CVEs -- six in total, none patchable from here. The runtime
  // that replaced all of that carries one advisory of its own, so putting it back into either
  // shipped section makes a default install dirty again while this page still calls it clean --
  // which is precisely why this reads both sections rather than only the one it stays out of.
  it('keeps the embedding runtime out of the packages a consumer installs', () => {
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('onnxruntime-node')
    expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain('onnxruntime-node')
    expect(Object.keys(pkg.devDependencies ?? {}), 'the tests still embed with it').toContain('onnxruntime-node')
  })

  // The package it replaced must not come back either, by either door. It is still a devDependency,
  // but only to regenerate the frozen tokenizer oracle -- nothing in src/ requires it any more.
  it('keeps the package it replaced out of the packages a consumer installs', () => {
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@xenova/transformers')
    expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain('@xenova/transformers')
  })

  // The one advisory this project does not clear for the reader. SECURITY.md states the count, the
  // identifier, why it is unreachable, and the override that fixes it -- and, because a plausible
  // fix that does not work is worse than none, that co-installing adm-zip does not dedupe. Rounding
  // any of that to "clean" is the failure this pins shut.
  it('discloses the adm-zip advisory the opt-in runtime carries, rather than rounding it to clean', () => {
    expect(security, 'the advisory identifier, so a reader can look it up').toContain('GHSA-xcpc-8h2w-3j85')
    expect(security, 'the package it is in').toContain('adm-zip')
    expect(security, 'why it is not reachable from token-goat').toContain('postinstall')
    expect(security, 'and the override that actually resolves it').toMatch(/"adm-zip":\s*"\^0\.6\.0"/)
    // The repository's own scan is clean only because of that override, so it has to still be there.
    expect(Object.keys(pkg.overrides ?? {}), 'the repository row is clean because of this pin').toContain('adm-zip')
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
  // packages the bundle inlines have since moved out of `dependencies`, which took it from 46 to
  // 40; replacing better-sqlite3 with the node:sqlite driver then took it from 40 to 2. The anchor
  // names the one that stays because the bundle genuinely resolves it at run time, so a demotion
  // of it fails here as well as in the bundle guard.
  it('states the size of a no-optional install that the lock file agrees with exactly', () => {
    // Not a text match: the number is read out of the document and compared against the tree
    // resolved from package-lock.json. Exact equality is available here and nowhere else, because
    // this half of the tree contains no platform-gated package -- every entry installs everywhere --
    // so the resolved answer is one number rather than one per runner.
    const measured = consumerPackageCount({ includeOptional: false })
    expect(
      statedInstallSize('an install without optional packages'),
      'SECURITY.md states the size of --omit=optional; package-lock.json resolves to this. Re-measure and update the row.',
    ).toBe(measured)
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(expect.arrayContaining(['jsonc-parser']))
  })

  it('resolves the same no-optional tree on every platform, which is what lets the check above be exact', () => {
    // The premise of the exact comparison, asserted rather than assumed. If a native package ever
    // lands in `dependencies`, this fails first and says so, instead of the check above starting to
    // fail on two of the four CI jobs for a reason that reads like a stale document.
    const sizes = (
      [
        ['win32', 'x64'],
        ['linux', 'x64'],
        ['darwin', 'arm64'],
      ] as const
    ).map(([os, cpu]) => consumerPackageCount({ includeOptional: false, os, cpu }))
    expect(new Set(sizes).size, `a no-optional install differs by platform: ${sizes.join(', ')}`).toBe(1)
  })

  it('names every package the table discusses, so a rename cannot orphan a row', () => {
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})])
    for (const name of ['sharp', 'puppeteer-core']) {
      expect(security, `${name} is discussed in SECURITY.md`).toContain(name)
      expect(declared, `${name} is still a dependency`).toContain(name)
    }
    // onnxruntime-node is the one the document discusses at length without shipping. It has to stay
    // named there, because the section is now largely about its absence and the command that brings
    // it back, and a silent rename would leave that whole passage pointing at nothing.
    expect(security).toContain('onnxruntime-node')
    expect(Object.keys(pkg.devDependencies ?? {})).toContain('onnxruntime-node')
    expect(declared).not.toContain('onnxruntime-node')
  })

  // The document does not merely say the model is optional; it prints the command that installs it.
  // A command that is wrong is worse than no command, and this one is easy to get wrong in a way
  // nobody notices: a global token-goat needs `-g` for the sibling to resolve, and a project
  // install must not have it. Both spellings are asserted because the document promises both.
  it('prints an install command for the runtime it no longer ships', () => {
    expect(security).toContain('npm install -g onnxruntime-node')
    expect(security).toMatch(/drop -g if token-goat is a project dependency/)
  })

  // Every advisory a consumer used to inherit came through that one package, so the document's
  // claim is now that a default install is clean rather than that some paths are unreachable. The
  // count is pinned for the same reason the no-optional count below it is: the document states a
  // number, and a number in a security document that nothing checks goes stale silently.
  it('never claims a default install is smaller than the lock file proves it must be', () => {
    // One-directional on purpose. A default install pulls the optional half, which is where every
    // prebuilt binary lives, so the true size depends on the platform (measured: 102 on win32/x64,
    // 106 on linux/x64, 103 on darwin/arm64) and on how far upstream trees have grown since the lock
    // was last built. The lock is therefore a floor and not the answer, and a floor is still worth
    // holding the document to: a document claiming fewer packages than the lock demonstrably
    // requires is wrong, with no measurement needed to know it.
    const stated = statedInstallSize('a default install')
    const floor = consumerPackageCount({ includeOptional: true })
    expect(
      stated,
      `SECURITY.md says a default install is ${stated} packages; package-lock.json already resolves to ${floor} on ${process.platform}/${process.arch}, so the figure is stale. Re-measure it.`,
    ).toBeGreaterThanOrEqual(floor)
  })

  // The floor above cannot see the other half of the drift: upstream trees grow inside version
  // ranges an install already accepts, and no file in this repository changes when they do. That
  // half is answered by telling the reader the figures are dated measurements rather than
  // constants, so the passage saying so is itself load-bearing and pinned here.
  it('presents the counts as dated measurements rather than as constants', () => {
    expect(security, 'the counting method has to survive, or the figures cannot be reproduced').toContain(
      'counting the directories under `node_modules`',
    )
    expect(security, 'and the date they were taken').toMatch(/counts as of \d{4}-\d{2}-\d{2}/)
    expect(security, 'and that they move on their own').toContain('drift upward')
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

  // An override whose key is also a direct dependency has to use npm's reference form, `$name`.
  // Repeating the range literally reads as a conflict even when the two ranges are identical:
  // Dependabot reported `dependency_file_not_resolvable` on `sharp` and abandoned the entire
  // grouped update, so every other package in that batch stopped getting version bumps as well,
  // and the failure was a resolution error rather than anything a test here noticed. `$name` means
  // "the version this manifest already asks for", which keeps the pin working -- without it
  // `@xenova/transformers` asks for sharp@^0.32.0 and npm nests a second, older copy -- while
  // leaving the direct dependency as the one place a version is written down.
  it('refers to the direct dependency instead of repeating its range', () => {
    const direct: Record<string, string> = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    }
    const alsoDirect = Object.keys(pkg.overrides ?? {}).filter((name) => name in direct)
    expect(
      alsoDirect,
      'no override names a direct dependency, so the loop below would pass without checking anything',
    ).not.toHaveLength(0)
    for (const name of alsoDirect) {
      expect(
        pkg.overrides?.[name],
        `overrides.${name} repeats the range declared for ${name} as a direct dependency (${direct[name]}); write "$${name}" instead, so npm and Dependabot can both still resolve the file`,
      ).toBe(`$${name}`)
    }
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

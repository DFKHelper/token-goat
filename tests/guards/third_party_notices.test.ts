/**
 * `dist/` is a bundle, and package.json's `files` ships the whole directory. Building it inlines the
 * source of roughly two dozen npm packages into the emitted chunks, which makes the tarball a binary
 * redistribution of all of them: MIT and BSD each ask for their copyright notice to travel with it,
 * and BlueOak for the license text or a link. The tarball carried almost none of that. esbuild's
 * default `legalComments` mode keeps only `/*!` and `@license` comments, which most of these
 * packages do not write, so exactly two of them left a trace in dist/ and there was no notices file
 * at all.
 *
 * THIRD_PARTY_NOTICES.md closes that, and this guard keeps it true. The failure mode it exists for
 * is silence: a new dependency reaches the bundle, the build still succeeds, dist/ still runs, and
 * nothing anywhere says a notice is now missing.
 *
 * The population is recomputed from the build's own metafile rather than read out of the document,
 * so a package that quietly joined the bundle fails here instead of being certified by a file that
 * never heard of it. The permissive allow-list is restated in this file rather than imported from
 * the generator: if the guard read the generator's own set, widening that set would silently widen
 * the guard too, and the one check that is supposed to object would be the check that stopped
 * objecting.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NOTICES = path.join(REPO, 'THIRD_PARTY_NOTICES.md')

/**
 * Licenses that ask only for the notice this file reproduces. Deliberately a separate copy of the
 * generator's list: see the header.
 */
const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
])

/** The packages the shipping build actually inlines, straight from its metafile. */
function bundledPackages(): string[] {
  const script =
    "import('./scripts/generate-third-party-notices.mjs')" +
    '.then(async (m) => { process.stdout.write(JSON.stringify(await m.bundledPackages())) })'
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64e6,
  })
  return JSON.parse(out) as string[]
}

function declaredLicense(name: string): string {
  const manifest = path.join(REPO, 'node_modules', ...name.split('/'), 'package.json')
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { license?: string }
  return typeof pkg.license === 'string' ? pkg.license : ''
}

describe('third-party notices', () => {
  const packages = bundledPackages()
  const document = fs.readFileSync(NOTICES, 'utf8')

  // A guard that passed on an empty population would prove nothing, and this one derives its
  // population from an esbuild run that can fail open.
  it('finds a real set of bundled packages to check', () => {
    expect(
      packages.length,
      'No third-party package was found in the build metafile. Either the bundle stopped inlining ' +
      'dependencies or the metafile walk in scripts/generate-third-party-notices.mjs has broken; ' +
      'this guard cannot pass on an empty population.',
    ).toBeGreaterThan(15)
  })

  it('names every package the build inlines', () => {
    const missing = packages.filter((name) => !document.includes(`\n## ${name} `))

    expect(
      missing,
      `THIRD_PARTY_NOTICES.md does not mention ${missing.length} bundled package(s): ` +
      `${missing.join(', ')}. Run \`npm run notices\` and commit the result.`,
    ).toEqual([])
  })

  // Section boundaries are anchored to the package names rather than to every `## ` in the file:
  // the license texts are reproduced verbatim, and some are themselves markdown. BlueOak-1.0.0
  // carries headings like `## Purpose` and `## Acceptance`, so a naive split invents sections that
  // no package owns.
  it('reproduces a real notice for each one, not an empty stub', () => {
    const found = packages
      .map((name) => ({ name, at: document.indexOf(`\n## ${name} `) }))
      .filter((s) => s.at >= 0)
      .sort((a, b) => a.at - b.at)

    expect(found.length).toBe(packages.length)

    const empty = found
      .filter((section, i) => {
        const end = i + 1 < found.length ? found[i + 1].at : document.length
        const body = document.slice(section.at, end)
        return !/copyright|permission is hereby granted|licensed under|blue oak/i.test(body)
      })
      .map((s) => s.name)

    expect(
      empty,
      `These sections carry no copyright or permission text, so they satisfy nothing: ${empty.join(', ')}`,
    ).toEqual([])
  })

  it('bundles only permissively licensed packages', () => {
    const restrictive = packages
      .map((name) => ({ name, license: declaredLicense(name) }))
      .filter((p) => !PERMISSIVE.has(p.license))
      .map((p) => `${p.name} (${p.license === '' ? 'no license field' : p.license})`)

    expect(
      restrictive,
      'A package with these terms is being copied into dist/ and shipped. That is a dependency ' +
      `decision, not a documentation one: ${restrictive.join(', ')}`,
    ).toEqual([])
  })

  // The document is generated, so the committed copy has to match what the generator produces from
  // the current tree. Without this, an edit by hand survives, and the notices describe a build that
  // has moved on.
  it('is up to date with the build', () => {
    const run = execFileSync(process.execPath, ['scripts/generate-third-party-notices.mjs', '--check'], {
      cwd: REPO,
      encoding: 'utf8',
    })

    expect(run).toContain('up to date')
  })

  // The generator reads each dependency's LICENSE file straight off disk and pastes it in. Several
  // ship CRLF, so the emitted document arrived with mixed line endings -- and `.gitattributes` sets
  // `* text=auto`, which normalizes to LF on commit. The committed file therefore never matched what
  // the generator produced from the same tree, so `--check` failed on a clean checkout: the release
  // gate could not pass no matter how correct the content was. Normalizing the generator's own output
  // is what makes the two agree.
  it('is written with LF endings, so the committed file matches what the generator emits', () => {
    const raw = fs.readFileSync(NOTICES, 'utf8')
    // Survival anchor: the document still has real content and real sections, so this cannot pass
    // by the file having been emptied.
    expect(raw.length).toBeGreaterThan(1000)
    expect(raw).toContain('\n## ')
    expect(raw.includes('\r'), 'THIRD_PARTY_NOTICES.md contains a CR, so `* text=auto` will normalize it on commit and the --check gate can never match').toBe(false)
  })

  it('ships inside the published package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { files?: string[] }

    expect(pkg.files ?? []).toContain('THIRD_PARTY_NOTICES.md')
  })
})

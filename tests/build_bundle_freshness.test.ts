// The test setup's decision to rebuild dist/ before the suite spawns it. It compared mtimes, and a mutation run restored src/pinned_fetch.ts with `mv` from a backup: the restored file carried its older timestamp, the bundle built from the mutant looked newer than every source, and the next full run tested the mutant rather than the code on disk (a bundle e2e test failed against code that was correct). PROVENANCE: HAND-DERIVED. Each case builds its own tree and states from first principles whether the bundle in it was built from the sources in it; nothing here is read off the implementation.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLE_OUTPUTS } from '../scripts/build-options.mjs'
import { buildScripts, bundleStampPath, sourceDigest, writeBundleStamp } from '../scripts/source-digest.mjs'
import { shouldBuildBundle } from './setup/build-bundle.js'

const DAY = 24 * 60 * 60 * 1000

describe('the test setup rebuilds dist/ exactly when it was built from other sources', () => {
  let root: string
  const src = (rel: string): string => path.join(root, 'src', rel)

  beforeEach(() => {
    vi.stubEnv('TOKEN_GOAT_TEST_FORCE_BUNDLE_BUILD', '')
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bundle-fresh-'))
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true })
    fs.mkdirSync(path.join(root, 'dist'))
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}\n')
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.writeFileSync(path.join(root, 'esbuild.config.mjs'), "import { defines } from './scripts/options.mjs'\nimport('./token-goat.core.mjs')\n")
    fs.writeFileSync(path.join(root, 'scripts', 'options.mjs'), "import { nested } from './nested.mjs'\nexport const defines = { A: '1' }\n")
    fs.writeFileSync(path.join(root, 'scripts', 'nested.mjs'), 'export const nested = 1\n')
    fs.writeFileSync(path.join(root, 'scripts', 'unrelated.mjs'), 'export const unrelated = 1\n')
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"verbatimModuleSyntax":true}}\n')
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"packages":{"node_modules/esbuild":{"version":"0.25.0"}}}\n')
    fs.writeFileSync(src('a.ts'), 'export const a = 1\n')
    fs.writeFileSync(src('nested/b.ts'), 'export const b = 2\n')
    for (const name of BUNDLE_OUTPUTS) fs.writeFileSync(path.join(root, 'dist', name), `${name}\n`)
    writeBundleStamp(root, sourceDigest(root))
    // Sources two days old and the bundle current, as after a real build: written back to back they share a millisecond, and a case about timestamps would then prove nothing.
    const twoDaysAgo = new Date(Date.now() - 2 * DAY)
    for (const f of [path.join(root, 'package.json'), path.join(root, 'esbuild.config.mjs'), src('a.ts'), src('nested/b.ts')]) fs.utimesSync(f, twoDaysAgo, twoDaysAgo)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('keeps a bundle built from the sources on disk', () => {
    expect(shouldBuildBundle(root)).toBe(false)
  })

  it('rebuilds when a source changed but carries a timestamp older than the bundle', () => {
    fs.writeFileSync(src('nested/b.ts'), 'export const b = 3\n')
    const old = new Date(Date.now() - DAY)
    fs.utimesSync(src('nested/b.ts'), old, old)
    expect(fs.statSync(src('nested/b.ts')).mtimeMs).toBeLessThan(fs.statSync(path.join(root, 'dist', 'token-goat.mjs')).mtimeMs)
    expect(shouldBuildBundle(root)).toBe(true)
  })

  it('rebuilds when a source file was added, renamed or removed', () => {
    fs.renameSync(src('a.ts'), src('a2.ts'))
    expect(shouldBuildBundle(root)).toBe(true)
    fs.renameSync(src('a2.ts'), src('a.ts'))
    expect(shouldBuildBundle(root)).toBe(false)
    fs.rmSync(src('nested/b.ts'))
    expect(shouldBuildBundle(root)).toBe(true)
  })

  it('rebuilds when package.json or the build script changed', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"y"}\n')
    expect(shouldBuildBundle(root)).toBe(true)
  })

  it('rebuilds when a module the build script imports changed, directly or through another import', () => {
    fs.writeFileSync(path.join(root, 'scripts', 'options.mjs'), "import { nested } from './nested.mjs'\nexport const defines = { A: '2' }\n")
    expect(shouldBuildBundle(root)).toBe(true)
    fs.writeFileSync(path.join(root, 'scripts', 'options.mjs'), "import { nested } from './nested.mjs'\nexport const defines = { A: '1' }\n")
    expect(shouldBuildBundle(root)).toBe(false)
    fs.writeFileSync(path.join(root, 'scripts', 'nested.mjs'), 'export const nested = 2\n')
    expect(shouldBuildBundle(root)).toBe(true)
  })

  // esbuild reads tsconfig.json, and the lockfile pins esbuild and every package the bundle inlines: `npm run deps:refresh` rewrites it and node_modules and leaves package.json alone.
  it.each(['tsconfig.json', 'package-lock.json'])('rebuilds when %s changed', (name) => {
    fs.appendFileSync(path.join(root, name), ' \n')
    expect(shouldBuildBundle(root)).toBe(true)
  })

  it('rebuilds when a directory linked into src/ changed, and ends a link back to an ancestor', () => {
    fs.mkdirSync(path.join(root, 'shared'))
    fs.writeFileSync(path.join(root, 'shared', 'c.ts'), 'export const c = 1\n')
    // A junction on Windows, which needs no privilege; a directory symlink elsewhere.
    fs.symlinkSync(path.join(root, 'shared'), src('linked'), 'junction')
    const withoutLoop = sourceDigest(root)
    // A link back to an ancestor adds no content, so it must add nothing to the digest. Walked through, it ends only where the path grows too long to stat, after hashing every file again under each longer name.
    fs.symlinkSync(path.join(root, 'src'), src('nested/up'), 'junction')
    expect(sourceDigest(root)).toBe(withoutLoop)
    writeBundleStamp(root, withoutLoop)
    expect(shouldBuildBundle(root)).toBe(false)
    fs.writeFileSync(path.join(root, 'shared', 'c.ts'), 'export const c = 2\n')
    expect(shouldBuildBundle(root)).toBe(true)
  })

  it('rebuilds when a file linked into src/ changed', (ctx) => {
    fs.writeFileSync(path.join(root, 'd.ts'), 'export const d = 1\n')
    try {
      fs.symlinkSync(path.join(root, 'd.ts'), src('d.ts'), 'file')
    } catch (err) {
      // A file symlink on Windows needs Developer Mode or an elevated shell; the directory case above covers the walk there.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw err
    }
    writeBundleStamp(root, sourceDigest(root))
    fs.writeFileSync(path.join(root, 'd.ts'), 'export const d = 2\n')
    expect(shouldBuildBundle(root)).toBe(true)
  })

  it('keeps the bundle when a script the build never imports changed', () => {
    fs.writeFileSync(path.join(root, 'scripts', 'unrelated.mjs'), 'export const unrelated = 2\n')
    expect(shouldBuildBundle(root)).toBe(false)
  })

  it('rebuilds when there is no stamp, as after a build that failed partway', () => {
    fs.rmSync(bundleStampPath(root))
    expect(shouldBuildBundle(root)).toBe(true)
  })

  // FORMAT-DERIVED from esbuild.config.mjs: the files it writes under a fixed name, which are the six tests/guards/published_tarball_carries_every_bundle_file.test.ts names literally. A stamp that matches says the sources are unchanged, not that every output is still in dist/: the glue alone gone left a dist/ the setup kept, and the suite ran against a bundle that could not load the WebAssembly runtime.
  it.each(['token-goat.mjs', 'token-goat.core.mjs', 'token-goat-hook.mjs', 'token-goat-hook-client.mjs', 'token-goat-hook-client.cjs', 'ort-wasm-simd-threaded.mjs'])('rebuilds when dist/%s is missing', (name) => {
    fs.rmSync(path.join(root, 'dist', name))
    expect(shouldBuildBundle(root)).toBe(true)
  })

  it('names every fixed output the build writes', () => {
    expect([...BUNDLE_OUTPUTS].sort()).toEqual(['ort-wasm-simd-threaded.mjs', 'token-goat-hook-client.cjs', 'token-goat-hook-client.mjs', 'token-goat-hook.mjs', 'token-goat.core.mjs', 'token-goat.mjs'])
  })

  it('rebuilds when two files swapped contents, which leaves the set of bytes unchanged', () => {
    fs.writeFileSync(src('a.ts'), 'export const b = 2\n')
    fs.writeFileSync(src('nested/b.ts'), 'export const a = 1\n')
    expect(shouldBuildBundle(root)).toBe(true)
  })
})

describe("the digest follows every local module this repo's build script imports", () => {
  // FORMAT-DERIVED from esbuild's own resolver: the local files it reaches bundling esbuild.config.mjs, packages left external. The digest finds them with a pattern over the source text, and an import shape the pattern misses would leave that module unhashed with nothing failing.
  it('names the same files esbuild resolves', async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const result = await esbuild.build({ absWorkingDir: root, entryPoints: ['esbuild.config.mjs'], bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    const resolved = Object.keys(result.metafile.inputs).map((p) => p.replaceAll('\\', '/'))
    expect(resolved.length).toBeGreaterThanOrEqual(3)
    expect([...buildScripts(root)].sort()).toEqual(resolved.sort())
  })
})

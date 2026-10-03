/** Regression: `indexing.skip_dirs` (and baseline.ts's SKIP_DIRS filter) were matched against every segment of a file's ABSOLUTE path, so a project kept under an ancestor that happens to be named like a skip directory (`C:/work/build/app`, `~/vendor/acme/app`, `/home/u/dist/proj`) had every file treated as vendored output: nothing was indexed and every surgical-read command came back empty. Only the segments below the project root may count. Provenance: every expected value below is HAND-DERIVED from the path text -- which directory names sit above the root and which below it -- independently of the implementation. The end-to-end half drives the real `cmdIndex` (what `index --walk` runs) and the worker's real default drain (`drainOnce` with no injected callback, so makeIndexer and makeRemover are the shipping defaults), then reads the `symbols` table back through `querySymbols`. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tempConfigPath } from './helpers/temp-config.js'

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

const _testConfigPath = tempConfigPath('tg-skip-dir-ancestors.toml')

import { isIgnoredIndexPath } from '../src/baseline.js'
import { cmdIndex } from '../src/cli.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { closeAllDbs } from '../src/db.js'
import { appendDirtyQueuePaths } from '../src/dirty_queue.js'
import { querySymbols } from '../src/index_reader.js'
import { isParseSkipEligible, isUnderSkipDir } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'

const SKIP = ['build', 'node_modules', 'vendor', 'dist']

describe('isUnderSkipDir with a known project root', () => {
  it.each([
    ['build', '/work/build/proj', '/work/build/proj/src/a.ts'],
    ['node_modules', '/work/node_modules/proj', '/work/node_modules/proj/src/a.ts'],
    ['vendor', '/home/u/vendor/acme/app', '/home/u/vendor/acme/app/lib/a.ts'],
    ['dist', '/home/u/dist/proj', '/home/u/dist/proj/a.ts'],
  ])('does not skip a file below a root kept under an ancestor named %s', (_ancestor, root, file) => {
    expect(isUnderSkipDir(file, SKIP, root)).toBe(false)
  })

  it('still skips node_modules and dist inside the root', () => {
    expect(isUnderSkipDir('/work/build/proj/node_modules/x.ts', SKIP, '/work/build/proj')).toBe(true)
    expect(isUnderSkipDir('/work/build/proj/dist/x.js', SKIP, '/work/build/proj')).toBe(true)
    expect(isUnderSkipDir('/work/build/proj/packages/a/vendor/x.ts', SKIP, '/work/build/proj')).toBe(true)
  })

  it('reads both separators and a differently spelled root', () => {
    expect(isUnderSkipDir('C:\\work\\build\\proj\\src\\a.ts', SKIP, 'C:/work/build/proj')).toBe(false)
    expect(isUnderSkipDir('C:\\work\\build\\proj\\dist\\a.js', SKIP, 'C:/work/build/proj/')).toBe(true)
  })

  it('tests the whole path when the file is not under the given root', () => {
    expect(isUnderSkipDir('/elsewhere/build/a.ts', SKIP, '/work/build/proj')).toBe(true)
    expect(isUnderSkipDir('/work/build/a.ts', SKIP, '/work/build/proj')).toBe(true)
  })

  it('does not treat the file name as a directory', () => {
    expect(isUnderSkipDir('/work/build/proj/dist', SKIP, '/work/build/proj')).toBe(false)
  })

  it('isParseSkipEligible forwards the root', () => {
    const cfg = { ...defaultConfig().indexing, skip_dirs: SKIP }
    expect(isParseSkipEligible('/nonexistent/build/proj/a.ts', cfg, '/nonexistent/build/proj')).toBe(false)
    expect(isParseSkipEligible('/nonexistent/build/proj/dist/a.ts', cfg, '/nonexistent/build/proj')).toBe(true)
  })
})

describe('isIgnoredIndexPath with a known project root', () => {
  it('ignores ancestors of the root and keeps SKIP_DIRS inside it', () => {
    expect(isIgnoredIndexPath('/work/build/proj/src/a.ts', '/work/build/proj')).toBe(false)
    expect(isIgnoredIndexPath('/home/u/vendor/acme/app/a.ts', '/home/u/vendor/acme/app')).toBe(false)
    expect(isIgnoredIndexPath('/work/build/proj/node_modules/x.ts', '/work/build/proj')).toBe(true)
    expect(isIgnoredIndexPath('/work/build/proj/dist/x.js', '/work/build/proj')).toBe(true)
  })

  it('keeps testing the whole path when no root is given and none can be found', () => {
    expect(isIgnoredIndexPath('/nonexistent-tg-root/node_modules/pkg/x.js')).toBe(true)
    expect(isIgnoredIndexPath('/nonexistent-tg-root/src/x.js')).toBe(false)
  })
})

let base: string
let proj: string
let dataHome: string
let dbPath: string

const FN = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

beforeEach(() => {
  // The real path: the project walk stops at the OS temp dir, and a short-name spelling would not match the root it derives.
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tg-skip-anc-'))
  proj = path.join(base, 'build', 'proj')
  dataHome = path.join(base, 'data')
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
  fs.mkdirSync(dataHome, { recursive: true })
  dbPath = path.join(dataHome, 'global.db')
  const cfg = defaultConfig()
  cfg.indexing.skip_dirs = SKIP
  saveConfig(cfg)
  invalidateConfigCache()
})

afterEach(() => {
  closeAllDbs()
  invalidateConfigCache()
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // best-effort: the next test's saveConfig rewrites it anyway
  }
  fs.rmSync(base, { recursive: true, force: true })
})

describe('isUnderSkipDir deriving the root from project markers', () => {
  it('tests only the segments below the outermost marker root', () => {
    fs.writeFileSync(path.join(proj, 'package.json'), '{}\n')
    fs.mkdirSync(path.join(proj, 'node_modules', 'dep'), { recursive: true })
    fs.writeFileSync(path.join(proj, 'node_modules', 'dep', 'package.json'), '{}\n')
    expect(isUnderSkipDir(path.join(proj, 'src', 'a.ts'), SKIP)).toBe(false)
    expect(isUnderSkipDir(path.join(proj, 'dist', 'a.js'), SKIP)).toBe(true)
    // A vendored package carries its own marker; the project around it is still the root.
    expect(isUnderSkipDir(path.join(proj, 'node_modules', 'dep', 'index.js'), SKIP)).toBe(true)
    expect(isIgnoredIndexPath(path.join(proj, 'src', 'a.ts'))).toBe(false)
    expect(isIgnoredIndexPath(path.join(proj, 'node_modules', 'dep', 'index.js'))).toBe(true)
  })
})

describe('a project kept under an ancestor named build (real default paths)', () => {
  it('index --walk indexes it, and resolving the symbol returns the right file', async () => {
    fs.writeFileSync(path.join(proj, 'src', 'widget.ts'), FN('ancestorWalkProbe'))
    fs.mkdirSync(path.join(proj, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(proj, 'dist', 'bundled.ts'), FN('ancestorWalkBundled'))

    await cmdIndex(proj, { walk: true, dbPath })

    const hits = querySymbols({ name: 'ancestorWalkProbe', limit: 10 }, dbPath)
    expect(hits.map((s) => normalizePath(s.filePath))).toEqual([normalizePath(path.join(proj, 'src', 'widget.ts'))])
    expect(querySymbols({ name: 'ancestorWalkBundled', limit: 10 }, dbPath)).toEqual([])
  })

  it('index --walk works from a root that carries no project marker at all', async () => {
    const loose = path.join(base, 'build', 'loose')
    fs.mkdirSync(loose, { recursive: true })
    fs.writeFileSync(path.join(loose, 'loose.ts'), FN('ancestorLooseProbe'))

    await cmdIndex(loose, { walk: true, dbPath })

    expect(querySymbols({ name: 'ancestorLooseProbe', limit: 10 }, dbPath)).toHaveLength(1)
  })

  it('the worker drain indexes an edit to it, and still refuses the vendored tree inside it', async () => {
    fs.writeFileSync(path.join(proj, 'package.json'), '{}\n')
    const widget = path.join(proj, 'src', 'widget.ts')
    fs.writeFileSync(widget, FN('ancestorDrainProbe'))
    const dep = path.join(proj, 'node_modules', 'dep')
    fs.mkdirSync(dep, { recursive: true })
    fs.writeFileSync(path.join(dep, 'package.json'), '{}\n')
    fs.writeFileSync(path.join(dep, 'index.ts'), FN('ancestorDrainVendored'))

    expect(appendDirtyQueuePaths(dataHome, [widget, path.join(dep, 'index.ts')])).toBe(true)
    // No injected callbacks: makeIndexer and makeRemover are the production defaults.
    drainOnce(dataHome)
    await pendingEmbeddings()

    const hits = querySymbols({ name: 'ancestorDrainProbe', limit: 10 }, dbPath)
    expect(hits.map((s) => normalizePath(s.filePath))).toEqual([normalizePath(widget)])
    expect(querySymbols({ name: 'ancestorDrainVendored', limit: 10 }, dbPath)).toEqual([])
  })
})

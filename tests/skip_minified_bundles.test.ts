/**
 * Minified bundles (*.min.js, *.min.css, ...) were indexed like source: a 166 KB ort.wasm.min.js produced 262 symbols, 231 of them
 * two characters or shorter, and a 898 KB transformers.min.js stored 950 KB of symbol bodies, so `symbol n` returned one-letter hits.
 * `indexing.skip_minified` (default true, global config only) now leaves them out through the same gate as skip_dirs/skip_files, and a
 * file already indexed is purged by the same pass. The end-to-end tests drive the worker's real default indexer (no injected callback).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tempConfigPath } from './helpers/temp-config.js'

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath, projectConfigPath: () => _testProjectConfigPath }
})

const _testConfigPath = tempConfigPath('tg-skip-minified.toml')
const _testProjectConfigPath = tempConfigPath('tg-skip-minified-project.toml')

import { invalidateConfigCache, loadConfig } from '../src/config.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { isMinifiedBundlePath } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { querySymbols } from '../src/index_reader.js'

// Provenance: HAND-DERIVED. The names are chosen from the rule (a `.min.`/`-min` suffix before a bundle extension) independently of the matcher; the not-skipped list is the must-not-drop set of ordinary names that merely contain "min".
const SKIPPED = ['jquery.min.js', 'bootstrap.min.css', 'vendor-min.js', 'x.min.mjs', 'X.MIN.JS', 'lib.min.cjs', 'static/js/a/b.min.js']
const KEPT = ['admin.js', 'min.js', 'terminal.js', 'app.ts', 'admin.min.ts', 'minify.js', 'domain.css', 'admin-minimal.js']

// Provenance: CAPTURE. Copied from the installed @xenova/transformers dependency (the file the defect was captured on). Falls back to a HAND-DERIVED single-line minified body when the optional dependency is absent.
const ORT_FIXTURE = path.join(process.cwd(), 'node_modules', '@xenova', 'transformers', 'node_modules', 'onnxruntime-web', 'dist', 'ort.wasm.min.js')
const HAND_MINIFIED = 'var n=function(t,e){return t+e},o=function(t){return n(t,1)};function r(a){return o(a)*2}function i(){return r(3)}module.exports={n:n,o:o,r:r,i:i};'

let TMP: string
let dataDir: string

function writeConfig(minified: boolean | undefined): void {
  fs.writeFileSync(_testConfigPath, minified === undefined ? '' : `[indexing]\nskip_minified = ${minified}\n`)
  invalidateConfigCache()
}

function seed(): string[] {
  fs.mkdirSync(path.join(TMP, 'static', 'js'), { recursive: true })
  const app = path.join(TMP, 'app.ts')
  const admin = path.join(TMP, 'admin.js')
  const min = path.join(TMP, 'static', 'js', 'ort.wasm.min.js')
  fs.writeFileSync(app, 'export function appMain(): number {\n  return 1\n}\n')
  fs.writeFileSync(admin, 'function adminPanel() {\n  return 2\n}\nmodule.exports = { adminPanel }\n')
  if (fs.existsSync(ORT_FIXTURE)) fs.copyFileSync(ORT_FIXTURE, min)
  else fs.writeFileSync(min, HAND_MINIFIED)
  return [app, admin, min]
}

async function drain(files: string[]): Promise<void> {
  const queue = path.join(dataDir, 'queue', 'dirty.txt')
  fs.mkdirSync(path.dirname(queue), { recursive: true })
  // The hook writer (hooks_edit.ts) enqueues normalizePath() spellings, forward slashes; a raw backslash path would never match the stored row key.
  fs.writeFileSync(queue, `${files.map((p) => normalizePath(p)).join('\n')}\n`)
  drainOnce(dataDir)
  await pendingEmbeddings()
}

function minRows(): number {
  const row = getDb(path.join(dataDir, 'global.db')).prepare("SELECT count(*) AS n FROM symbols WHERE file_path LIKE '%.min.js'").get() as { n: number }
  return row.n
}

beforeEach(() => {
  TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-skip-min-')))
  dataDir = path.join(TMP, 'data')
  try { fs.unlinkSync(_testProjectConfigPath) } catch { /* ok */ }
  writeConfig(undefined)
})

afterEach(() => {
  closeAllDbs()
  invalidateConfigCache()
  try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
  try { fs.unlinkSync(_testProjectConfigPath) } catch { /* ok */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('isMinifiedBundlePath', () => {
  it.each(SKIPPED)('matches %s', (name) => {
    expect(isMinifiedBundlePath(name)).toBe(true)
  })
  it.each(KEPT)('does not match %s', (name) => {
    expect(isMinifiedBundlePath(name)).toBe(false)
  })
})

describe('indexing.skip_minified config', () => {
  it('defaults to true', () => {
    expect(loadConfig().indexing.skip_minified).toBe(true)
  })

  it('a global false is honoured', () => {
    writeConfig(false)
    expect(loadConfig().indexing.skip_minified).toBe(false)
  })

  it('a project .token-goat.toml cannot turn it off (locked key)', () => {
    fs.writeFileSync(_testProjectConfigPath, '[indexing]\nskip_minified = false\n')
    invalidateConfigCache()
    expect(loadConfig().indexing.skip_minified).toBe(true)
  })
})

describe('minified bundles on the real worker drain', () => {
  it('leaves the bundle out and still indexes its sibling sources', async () => {
    await drain(seed())
    const db = path.join(dataDir, 'global.db')
    expect(minRows()).toBe(0)
    expect(querySymbols({ name: 'appMain', limit: 10 }, db).length).toBe(1)
    expect(querySymbols({ name: 'adminPanel', limit: 10 }, db).length).toBe(1)
  })

  it('indexes the bundle when skip_minified is false in the global config', async () => {
    writeConfig(false)
    await drain(seed())
    expect(minRows()).toBeGreaterThan(0)
  })

  it('purges rows already indexed once skip_minified is flipped on', async () => {
    writeConfig(false)
    const files = seed()
    await drain(files)
    expect(minRows()).toBeGreaterThan(0)
    writeConfig(true)
    await drain(files)
    expect(minRows()).toBe(0)
    expect(querySymbols({ name: 'appMain', limit: 10 }, path.join(dataDir, 'global.db')).length).toBe(1)
  })
})

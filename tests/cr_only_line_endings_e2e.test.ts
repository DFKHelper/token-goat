/** A CR-only source file through the real default path: the dirty queue drained by `drainOnce` with no injected callback, so `makeIndexer` and `indexFileSync` are the production ones, then the symbols rows and the shipped bundle's `read`. PROVENANCE: HAND-DERIVED. The fixture is two TypeScript functions joined with a lone `\r`; the expected spans are counted from its lines by hand, independently of the extractor. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { BUNDLE } from './helpers/bundle.js'

const MAC = ['export function alpha() {', '  return 1', '}', 'export function beta() {', '  return 2', '}', ''].join('\r')

let TMP: string
let DB_PATH: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tg-cr-e2e-'))
  DB_PATH = path.join(TMP, 'global.db')
  env = { ...process.env, TOKEN_GOAT_HOME: TMP, LOCALAPPDATA: TMP, XDG_DATA_HOME: TMP, TOKEN_GOAT_EMBEDDINGS_ENABLED: '0' }
  spawnSync('git', ['init', '-q'], { cwd: TMP })
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('a CR-only file reaches the index through the production drain', () => {
  it('stores each function on its own lines, and read returns only the asked-for body', async () => {
    const abs = path.join(TMP, 'mac.ts')
    fs.writeFileSync(abs, MAC, 'utf8')
    fs.mkdirSync(path.join(TMP, 'queue'), { recursive: true })
    fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${normalizePath(abs)}\n`)
    expect(drainOnce(TMP)).toBe(1)
    await pendingEmbeddings()

    const rows = getDb(DB_PATH).prepare('SELECT name, line_start, line_end FROM symbols ORDER BY line_start, name').all() as Array<{ name: string; line_start: number; line_end: number }>
    expect(rows.map((r) => `${r.name} ${r.line_start}-${r.line_end}`)).toEqual(['alpha 1-3', 'beta 4-6'])

    const r = spawnSync(process.execPath, [BUNDLE, 'read', 'mac.ts::beta'], { cwd: TMP, env, encoding: 'utf8', timeout: 60000 })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('export function beta() {')
    expect(r.stdout).toContain('return 2')
    expect(r.stdout).not.toContain('alpha')
    expect(r.stdout).not.toContain('return 1')
  }, 60_000)
})

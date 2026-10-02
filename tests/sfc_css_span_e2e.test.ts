/** Multi-line spans for Vue/Svelte/Astro script symbols (and, below, CSS/SCSS rules) through the real default path: the dirty queue drained by `drainOnce` with no injected callback, so `makeIndexer` and `indexFileSync` are the production ones, then the symbols row and the shipped bundle's `read`. A mock-callback test never reaches the adapter wiring that once left these symbols one line long. PROVENANCE: HAND-DERIVED. File contents and the expected spans are counted from the fixture text in this file, independently of the extractors. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { BUNDLE } from './helpers/bundle.js'

const VUE = ['<script setup>', 'function vueMulti() {', '  return 1', '}', '', 'class VueKlass {', '  run() {}', '}', '</script>', '', '<template>', '  <p>{{ vueMulti() }}</p>', '</template>', ''].join('\n')
const SVELTE = ['<script>', '  function svelteAlpha() {', '    return 2', '  }', '</script>', '', '<p>{svelteAlpha()}</p>', ''].join('\n')
const CSS = ['.css-multi {', '  color: red;', '  margin: 0;', '}', '', '.p,', '.q {', '  top: 0;', '}', ''].join('\n')
const SCSS = ['.card {', '  .title {', '    color: red;', '  }', '}', ''].join('\n')

// [file name, content, symbol, first line, last line, body lines that must all come back from `read`]
const CASES: Array<[string, string, string, number, number, string[]]> = [
  ['x.vue', VUE, 'vueMulti', 2, 4, ['function vueMulti() {', '  return 1', '}']],
  ['x.vue', VUE, 'VueKlass', 6, 8, ['class VueKlass {', '  run() {}', '}']],
  ['Widget.svelte', SVELTE, 'svelteAlpha', 2, 4, ['function svelteAlpha() {', '    return 2', '  }']],
  ['x.css', CSS, '.css-multi', 1, 4, ['.css-multi {', '  color: red;', '  margin: 0;', '}']],
  ['x.css', CSS, '.q', 7, 9, ['.q {', '  top: 0;', '}']],
  ['x.scss', SCSS, '.card', 1, 5, ['.card {', '  .title {', '    color: red;', '  }', '}']],
  ['x.scss', SCSS, '.title', 2, 4, ['.title {', '    color: red;', '  }']],
]

let TMP: string
let DB_PATH: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tg-span-e2e-'))
  DB_PATH = path.join(TMP, 'global.db')
  env = { ...process.env, TOKEN_GOAT_HOME: TMP, LOCALAPPDATA: TMP, XDG_DATA_HOME: TMP, TOKEN_GOAT_EMBEDDINGS_ENABLED: '0' }
  spawnSync('git', ['init', '-q'], { cwd: TMP })
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

async function drain(file: string, content: string): Promise<string> {
  const abs = path.join(TMP, file)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  fs.mkdirSync(path.join(TMP, 'queue'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${normalizePath(abs)}\n`)
  expect(drainOnce(TMP)).toBe(1)
  await pendingEmbeddings()
  return abs
}

function span(name: string): { line_start: number; line_end: number } | undefined {
  return getDb(DB_PATH).prepare('SELECT line_start, line_end FROM symbols WHERE name = ?').get(name) as { line_start: number; line_end: number } | undefined
}

function read(spec: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, 'read', spec], { cwd: TMP, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('multi-line spans reach the index through the production drain', () => {
  for (const [file, content, name, start, end, body] of CASES) {
    it(`${file}::${name} is stored as ${start}-${end} and read returns the whole body`, async () => {
      await drain(file, content)
      expect(span(name)).toEqual({ line_start: start, line_end: end })
      const r = read(`${file}::${name}`)
      expect(r.status, r.stderr).toBe(0)
      for (const line of body) expect(r.stdout, line).toContain(line)
      expect(r.stdout).toContain(`# ${end - start + 1} lines`)
    }, 60_000)
  }

  it('re-indexes an already-indexed file whose parser stamp predates the span fix, though its bytes never moved', async () => {
    await drain('x.vue', VUE)
    // The state an upgraded binary meets: same content, rows written by the old one-line extractor.
    getDb(DB_PATH).prepare("UPDATE files SET parser_sha = '0000000000000000'").run()
    getDb(DB_PATH).prepare("UPDATE symbols SET line_end = line_start WHERE name = 'vueMulti'").run()
    expect(span('vueMulti')).toEqual({ line_start: 2, line_end: 2 })
    await drain('x.vue', VUE)
    expect(span('vueMulti')).toEqual({ line_start: 2, line_end: 4 })
  }, 60_000)
})

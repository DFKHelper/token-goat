/** Built-bundle check that an unconfined `symbol NAME` run from a project lists that project's definition first, though another indexed project's path sorts ahead of it. PROVENANCE: HAND-DERIVED. The projects are written below: `aaa-other` defines 25 functions named `parseThing9k`, `zzz-mine` defines one, and the expected first row is computed from those names. The run goes through dist/token-goat.mjs with the real indexer (`index . --walk`). */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

let root: string
let mine: string
let env: NodeJS.ProcessEnv

function tg(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-symfirst-bundle-'))
  const home = path.join(root, 'home')
  const other = path.join(root, 'aaa-other')
  mine = path.join(root, 'zzz-mine')
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  fs.mkdirSync(path.join(other, 'src'), { recursive: true })
  fs.mkdirSync(path.join(mine, 'src'), { recursive: true })
  env = {
    ...process.env,
    TOKEN_GOAT_HOME: path.join(root, 'tg-home'),
    LOCALAPPDATA: path.join(root, 'data'),
    XDG_DATA_HOME: path.join(root, 'data'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
  }
  for (let i = 0; i < 25; i++) {
    fs.writeFileSync(path.join(other, 'src', `m${String(i).padStart(2, '0')}.ts`), `export function parseThing9k(a: number): number {\n  return a + ${i}\n}\n`)
  }
  fs.writeFileSync(path.join(mine, 'src', 'own.ts'), 'export function parseThing9k(a: string): string {\n  return a\n}\n')
  for (const dir of [other, mine]) {
    const idx = tg(dir, ['index', '.', '--walk'])
    expect(idx.status, idx.stderr).toBe(0)
  }
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle lists the current project first', () => {
  it('prints the local definition on the first line of an unconfined lookup', () => {
    const r = tg(mine, ['symbol', 'parseThing9k'])
    expect(r.status, r.stderr).toBe(0)
    const first = r.stdout.split('\n').find((l) => l.startsWith('# parseThing9k'))
    expect(first).toContain('src/own.ts')
    expect(r.stdout).toContain('m00.ts')
  })

  it('emits the same order for --json', () => {
    const r = tg(mine, ['symbol', 'parseThing9k', '--json'])
    expect(r.status, r.stderr).toBe(0)
    const payload = JSON.parse(r.stdout) as { items: Array<{ filePath: string }>; totalCount: number }
    expect(payload.items[0]?.filePath).toContain('src/own.ts')
    expect(payload.totalCount).toBe(26)
  })
})

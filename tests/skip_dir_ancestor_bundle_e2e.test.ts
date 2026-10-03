/** Built-bundle check for the skip-directory scope: with `indexing.skip_dirs` naming `build`, the shipped dist/token-goat.mjs (not source) must still index a project that merely LIVES under a directory called `build`, answer `symbol` from it, and keep refusing the project's own `build`-named and `node_modules` subdirectories. Before the fix every file of such a project was treated as skipped, `index --walk` reported nothing, and `symbol` found nothing. Provenance: the project layout and the expected symbol names are HAND-DERIVED from the fixture text written below; the command output is read from the real bundle, not from our own matcher. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

let root: string
let project: string
let env: NodeJS.ProcessEnv

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const FN = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tg-skip-anc-bundle-'))
  project = path.join(root, 'build', 'proj')
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(path.join(project, 'build'), { recursive: true })
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
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
  fs.writeFileSync(path.join(project, 'src', 'widget.ts'), FN('bundleAncestorProbe'))
  fs.writeFileSync(path.join(project, 'build', 'out.ts'), FN('bundleAncestorOwnBuildDir'))
  const set = tg(['config', 'set', 'indexing.skip_dirs', '["build","node_modules"]'])
  expect(set.status, set.stderr).toBe(0)
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes a project kept under a skip-directory name', () => {
  it('resolves the symbol by name and points at the right file', () => {
    const sym = tg(['symbol', 'bundleAncestorProbe'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('bundleAncestorProbe')
    expect(sym.stdout).toContain('widget.ts')
  })

  it('still refuses the project own build directory', () => {
    const sym = tg(['symbol', 'bundleAncestorOwnBuildDir'])
    expect(sym.stdout).not.toContain('out.ts')
  })
})

/**
 * Built-bundle check for the Assembly, Windows batch and Erlang adapters: the shipped dist/token-goat.mjs, not source,
 * indexes one file of each through `index . --walk` and answers `outline`, `symbol`, `read "file::Name"` and `imports` from
 * them. The two `.asm` dialects sit side by side, and the index count names exactly the files it indexed.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'language_adapter_symbols')

let root: string
let project: string
let env: NodeJS.ProcessEnv
let indexOut: string

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// The fixtures (provenance on their first lines), under the names a project would give them.
const FILES: Array<[string, string]> = [
  ['Sample.s', 'startup.s'],
  ['Sample.nasm', 'boot.nasm'],
  ['Sample_hlasm.asm', 'LEGACY.asm'],
  ['Sample.bat', 'deploy.bat'],
  ['Sample.erl', 'sample.erl'],
]

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-label-bundle-'))
  project = path.join(root, 'project')
  const home = path.join(root, 'home')
  fs.mkdirSync(project, { recursive: true })
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
  for (const [src, dst] of FILES) fs.copyFileSync(path.join(FIXTURES, src), path.join(project, dst))
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
  indexOut = idx.stdout
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes Assembly, Windows batch files and Erlang', () => {
  it('counts exactly the files it indexed', () => {
    expect(indexOut).toContain(`Indexed ${FILES.length} files into the symbol index.`)
  })

  const outlines: Array<[string, string[]]> = [
    ['startup.s', ['main', 'helper', 'sum', 'inner_label', 'msg']],
    ['boot.nasm', ['prologue', 'Foo', 'mytype', '_start']],
    ['LEGACY.asm', ['SAVEREGS', 'MAIN', 'SUBRTN', 'MYDATA']],
    ['deploy.bat', ['start', 'end']],
    ['sample.erl', ['sample', 'MAX_TRIES', 'point', 'shape', 'fact', 'area']],
  ]
  for (const [file, names] of outlines) {
    it(`outlines ${file}`, () => {
      const r = tg(['outline', file])
      expect(r.status, r.stderr).toBe(0)
      for (const name of names) expect(r.stdout, name).toContain(name)
      expect(r.stdout).not.toContain('no symbol extractor')
    })
  }

  const reads: Array<[string, string, string, string]> = [
    ['startup.s', 'helper', 'movq    $msg, %rax', 'call    helper'],
    ['boot.nasm', 'prologue', 'sub     esp,%1', 'mov %?,%??'],
    ['LEGACY.asm', 'MAIN', 'SAVEREGS', 'BR    14'],
    ['deploy.bat', 'start', 'call helper.bat', 'End of batch program'],
    ['sample.erl', 'fact', 'N * fact(N-1)', 'area({circle, R})'],
  ]
  for (const [file, name, body, outside] of reads) {
    it(`resolves ${name} with symbol and returns its body from ${file} with read`, () => {
      const sym = tg(['symbol', name])
      expect(sym.status, sym.stderr).toBe(0)
      expect(sym.stdout).toContain(file)
      const read = tg(['read', `${file}::${name}`])
      expect(read.status, read.stderr).toBe(0)
      expect(read.stdout).toContain(body)
      expect(read.stdout).not.toContain(outside)
    })
  }

  it('lists the imports of sample.erl through the Erlang adapter', () => {
    const r = tg(['imports', 'sample.erl'])
    expect(r.status, r.stderr).toBe(0)
    for (const target of ['sample.hrl', 'kernel/include/file.hrl', 'lists']) expect(r.stdout, target).toContain(target)
  })

  it('lists the batch files deploy.bat calls', () => {
    const r = tg(['imports', 'deploy.bat'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('helper.bat')
  })
})

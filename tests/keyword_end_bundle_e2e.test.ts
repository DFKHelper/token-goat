/**
 * Built-bundle check for the Fortran, Pascal, MATLAB and CMake adapters: the shipped dist/token-goat.mjs, not source, indexes one file of each through `index . --walk` and answers `outline`, `symbol`, `read "file::Name"` and `imports` from them. A Mathematica `.m` and a Puppet `.pp` beside them are left alone, and the index count names exactly the files it indexed.
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
  ['Sample.f90', 'geometry.f90'],
  ['Sample.f', 'legacy.f'],
  ['Sample.pas', 'Shapes.pas'],
  ['Sample.dpk', 'BoldIB.dpk'],
  ['matlab_isolate_axes.m', 'isolate_axes.m'],
  ['Sample_classdef.m', 'Motor.m'],
  ['Sample.cmake', 'CMakeLists.txt'],
]

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-keyword-bundle-'))
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
  fs.copyFileSync(path.join(FIXTURES, 'mathematica_package.m'), path.join(project, 'Collatz.m'))
  // FORMAT-DERIVED: https://www.puppet.com/docs/puppet/7/lang_classes.html (a class definition in a .pp manifest).
  fs.writeFileSync(path.join(project, 'init.pp'), "class apache (String $version = 'latest') {\n  package { 'httpd': ensure => $version }\n}\n")
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
  indexOut = idx.stdout
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes Fortran, Pascal, MATLAB and CMake', () => {
  it('counts exactly the files it indexed', () => {
    expect(indexOut).toContain(`Indexed ${FILES.length} files into the symbol index.`)
  })

  const outlines: Array<[string, string[]]> = [
    ['geometry.f90', ['my_mod', 't_pair', 'print_matrix', 'vector_norm', 'use_mod']],
    ['legacy.f', ['MAIN', 'FILL', 'TWICE']],
    ['Shapes.pas', ['Shapes', 'TClassA', 'Describe', 'Pad']],
    ['BoldIB.dpk', ['BoldIB']],
    ['isolate_axes.m', ['isolate_axes', 'allchildren', 'allancestors']],
    ['Motor.m', ['Motor', 'SpeedRange', 'startMotor']],
    ['CMakeLists.txt', ['Tutorial', 'add_tutorial_test', 'Print_Args', 'MathFunctions']],
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
    ['geometry.f90', 'vector_norm', 'norm = sqrt(sum(vec**2))', 'subroutine show_pair'],
    ['legacy.f', 'FILL', '   10 CONTINUE', 'REAL FUNCTION TWICE'],
    ['Shapes.pas', 'Describe', 'Result := Pad(FName);', 'procedure DoSomething;'],
    ['Motor.m', 'startMotor', "notify(obj,'SpeedChanged')", 'function stopMotor'],
    ['CMakeLists.txt', 'add_tutorial_test', 'add_test(NAME ${name}', 'MACRO(Print_Args)'],
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

  it('lists the imports of CMakeLists.txt through the CMake adapter', () => {
    const r = tg(['imports', 'CMakeLists.txt'])
    expect(r.status, r.stderr).toBe(0)
    for (const target of ['CTest', 'Threads', 'MathFunctions']) expect(r.stdout, target).toContain(target)
  })

  it('leaves the Mathematica .m and the Puppet .pp unindexed', () => {
    expect(tg(['symbol', 'Collatz']).stdout).not.toContain('Collatz.m')
    expect(tg(['symbol', 'apache']).stdout).not.toContain('init.pp')
  })
})

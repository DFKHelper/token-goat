/**
 * Built-bundle check for the Objective-C, Groovy, Perl, Solidity, Thrift, GLSL, HLSL, WGSL and Metal adapters: the shipped dist/token-goat.mjs, not source, indexes one file of each through `index . --walk` and answers `outline`, `symbol` and `read "file::Name"` from them. A Mathematica `.m` and a Prolog `.pl` beside them are left alone, and the index count names exactly the files it indexed.
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

// The CAPTURE fixtures (provenance on their first lines), under the names their projects give them.
const FILES: Array<[string, string]> = [
  ['Sample.m', 'AFSecurityPolicy.m'],
  ['Sample.groovy', 'StackSpec.groovy'],
  ['Jenkinsfile.sample', 'Jenkinsfile'],
  ['Sample.pm', 'Basename.pm'],
  ['Sample.sol', 'Ownable.sol'],
  ['Sample.thrift', 'tutorial.thrift'],
  ['Sample.frag', 'lights.frag'],
  ['Sample.hlsl', 'shaders.hlsl'],
  ['Sample.wgsl', 'shadow.wgsl'],
  ['Sample.metal', 'Shaders.metal'],
]

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-brace-bundle-'))
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
  fs.copyFileSync(path.join(FIXTURES, 'prolog_pairs.pl'), path.join(project, 'pairs.pl'))
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
  indexOut = idx.stdout
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes Objective-C, Groovy, Perl, Solidity, Thrift and shaders', () => {
  it('counts exactly the files it indexed', () => {
    expect(indexOut).toContain(`Indexed ${FILES.length} files into the symbol index.`)
  })

  const outlines: Array<[string, string[]]> = [
    ['AFSecurityPolicy.m', ['AFSecurityPolicy', 'AFServerTrustIsValid', 'evaluateServerTrust:forDomain:']],
    ['StackSpec.groovy', ['EmptyStackSpec', 'StackWithOneElementSpec', 'push']],
    ['Jenkinsfile', ['local', 'global']],
    ['Basename.pm', ['File::Basename', 'fileparse', 'dirname']],
    ['Ownable.sol', ['Ownable', 'onlyOwner', 'transferOwnership']],
    ['tutorial.thrift', ['Calculator', 'Work', 'InvalidOperation']],
    ['lights.frag', ['DirLight', 'CalcSpotLight', 'main']],
    ['shaders.hlsl', ['SceneConstantBuffer', 'PSInput', 'VSMain']],
    ['shadow.wgsl', ['Scene', 'FragmentInput', 'shadowDepthTextureSize']],
    ['Shaders.metal', ['Vertex', 'vertex_project', 'fragment_flatcolor']],
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
    ['AFSecurityPolicy.m', 'AFServerTrustIsValid', 'kSecTrustResultProceed', 'AFCertificateTrustChainForServerTrust'],
    ['StackSpec.groovy', 'EmptyStackSpec', 'def stack = new Stack()', 'StackWithOneElementSpec'],
    ['Jenkinsfile', 'global', 'stage("global")', 'BAR = "STAGE"'],
    ['Basename.pm', 'dirname', 'fileparse($path)', 'sub basename'],
    ['Ownable.sol', 'onlyOwner', '_checkOwner();', 'function owner()'],
    ['tutorial.thrift', 'Work', '1: i32 num1 = 0,', 'exception InvalidOperation'],
    ['lights.frag', 'CalcDirLight', 'normalize(-light.direction)', 'CalcPointLight('],
    ['shaders.hlsl', 'PSMain', 'return input.color;', 'VSMain'],
    ['shadow.wgsl', 'FragmentInput', 'fragNorm', 'albedo'],
    ['Shaders.metal', 'vertex_project', 'vertexOut.color = vertices[vid].color;', 'fragment half4'],
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

  it('leaves the Mathematica .m and the Prolog .pl unindexed', () => {
    expect(tg(['symbol', 'Collatz']).stdout).not.toContain('Collatz.m')
    expect(tg(['symbol', 'pairs_keys_values']).stdout).not.toContain('pairs.pl')
  })
})

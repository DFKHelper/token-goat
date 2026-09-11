/**
 * Built-bundle check for the COBOL and Natural adapters: the shipped dist/token-goat.mjs, not source, indexes uppercase `.CBL` and `.NSP` files and answers `outline`, `symbol` and `read "file::Name"` from them. This is the only test that proves both adapters survived bundling and are reached from the real CLI path.
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

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cobol-natural-bundle-'))
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
  // The FORMAT-DERIVED fixtures (provenance on their first lines), copied under uppercase names as mainframe exports write them.
  fs.copyFileSync(path.join(FIXTURES, 'Sample.cbl'), path.join(project, 'PAYROLL.CBL'))
  fs.copyFileSync(path.join(FIXTURES, 'Sample.nsp'), path.join(project, 'EMPRPT.NSP'))
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes COBOL and Natural', () => {
  it('outlines an uppercase .CBL file', () => {
    const r = tg(['outline', 'PAYROLL.CBL'])
    expect(r.status, r.stderr).toBe(0)
    for (const name of ['PAYROLL', 'EMP-FILE', 'WS-TOTAL', 'MAIN-PARA', 'CALC-PARA', 'CALC-EXIT']) expect(r.stdout).toContain(name)
    expect(r.stdout).not.toContain('no symbol extractor')
  })

  it('outlines an uppercase .NSP file', () => {
    const r = tg(['outline', 'EMPRPT.NSP'])
    expect(r.status, r.stderr).toBe(0)
    for (const name of ['EMPRPT', '#COUNTER', 'EMP', 'ADD-ONE']) expect(r.stdout).toContain(name)
    expect(r.stdout).not.toContain('no symbol extractor')
  })

  it('resolves a COBOL paragraph with symbol and returns its body with read', () => {
    const sym = tg(['symbol', 'CALC-PARA'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('PAYROLL.CBL')
    const read = tg(['read', 'PAYROLL.CBL::CALC-PARA'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('ADD EMP-PAY TO WS-TOTAL')
    expect(read.stdout).not.toContain('CALC-EXIT.')
  })

  it('resolves a Natural subroutine with symbol and returns its body with read', () => {
    const sym = tg(['symbol', 'ADD-ONE'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('EMPRPT.NSP')
    const read = tg(['read', 'EMPRPT.NSP::ADD-ONE'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('DEFINE SUBROUTINE ADD-ONE')
    expect(read.stdout).toContain('END-SUBROUTINE')
  })

  it('lists COPY and USING targets with imports', () => {
    expect(tg(['imports', 'PAYROLL.CBL']).stdout).toContain('PAYCONST')
    const nat = tg(['imports', 'EMPRPT.NSP']).stdout
    expect(nat).toContain('EMPLDA')
    expect(nat).toContain('COPYCC')
  })

  it('returns the PERFORM call site for a COBOL paragraph with refs', () => {
    const r = tg(['refs', 'CALC-PARA'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('PAYROLL.CBL')
  })
})

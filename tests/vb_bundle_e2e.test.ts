/**
 * Built-bundle check for the Visual Basic adapter: the shipped dist/token-goat.mjs, not source, indexes a small VB project and answers `symbol` and `read` from it. This is the only test that proves the adapter survived bundling and is reached from the real CLI path, including the `.cls` content refinement.
 */
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

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vb-bundle-'))
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
  // HAND-DERIVED: VB.NET written from the Visual Basic language reference, https://learn.microsoft.com/en-us/dotnet/visual-basic/language-reference/statements/.
  fs.writeFileSync(
    path.join(project, 'Greeter.vb'),
    'Namespace Demo\n    Public Class Greeter\n        Public Function Hello(ByVal who As String) As String\n            If who = "" Then\n                Return "hi"\n            End If\n            Return "hi " & who\n        End Function\n    End Class\nEnd Namespace\n',
  )
  // HAND-DERIVED: an invented class module carrying the header the VB6 IDE writes above every .cls (VERSION 1.0 CLASS, the BEGIN/MultiUse/END block, then the Attribute lines), with one property below it.
  fs.writeFileSync(
    path.join(project, 'CAssetInfo.cls'),
    'VERSION 1.0 CLASS\r\nBEGIN\r\n  MultiUse = -1  \'True\r\nEND\r\nAttribute VB_Name = "CAssetInfo"\r\nOption Explicit\r\nPublic Property Get FileName() As String\r\n   FileName = "x"\r\nEnd Property\r\n',
  )
  // HAND-DERIVED: `#Region` from https://learn.microsoft.com/en-us/dotnet/visual-basic/language-reference/directives/region-directive and the `'''` doc comment from https://learn.microsoft.com/en-us/dotnet/visual-basic/programming-guide/program-structure/documenting-your-code-with-xml
  fs.writeFileSync(
    path.join(project, 'Regions.vb'),
    "Public Class Counter\n#Region \"Helpers\"\n    ''' <summary>Adds one.</summary>\n    Public Function Bump(n As Integer) As Integer\n        Return n + 1\n    End Function\n#End Region\n\n    Public Sub Outside()\n    End Sub\nEnd Class\n",
  )
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes Visual Basic', () => {
  it('resolves a VB.NET method with symbol and returns its whole body with read', () => {
    const sym = tg(['symbol', 'Hello'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('Greeter.vb')

    const read = tg(['read', 'Greeter.vb::Hello'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('Public Function Hello(ByVal who As String) As String')
    expect(read.stdout).toContain('Return "hi " & who')
    expect(read.stdout).toContain('End Function')
  })

  it('indexes a VB6 class module .cls through the content refinement', () => {
    const sym = tg(['symbol', 'FileName'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('CAssetInfo.cls')
  })

  it('section reads a #Region block to its #End Region', () => {
    const sec = tg(['section', 'Regions.vb::Helpers'])
    expect(sec.status, sec.stderr).toBe(0)
    expect(sec.stdout).toContain('Public Function Bump(n As Integer) As Integer')
    expect(sec.stdout).toContain('#End Region')
    expect(sec.stdout).not.toContain('Public Sub Outside()')
  })

  it("stores the ''' doc comment as the symbol's docstring", () => {
    const sym = tg(['symbol', 'Bump', '--json'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('<summary>Adds one.</summary>')
  })

  it('names Visual Basic, not Apex, in the ref-blind notice for a VB6 .cls symbol', () => {
    const refs = tg(['refs', 'FileName'])
    expect(refs.stderr).toContain('Visual Basic call sites are not indexed')
    expect(refs.stderr).not.toMatch(/apex call sites/i)
  })
})

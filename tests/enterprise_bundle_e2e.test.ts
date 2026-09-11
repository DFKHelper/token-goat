/**
 * Built-bundle check for the ABAP, SAS, PL/I, RPG, JCL and OpenEdge ABL adapters: the shipped dist/token-goat.mjs, not source, indexes one file of each through `index . --walk` and answers `outline`, `symbol` and `read "file::Name"` from them. An ABL `.p` and `.cls` are found by content, so this also proves the content routing is reached from the real walker, and that a Pascal `.p` beside them is left alone.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'language_adapter_symbols')

// FORMAT-DERIVED: CLASS https://documentation.progress.com/output/ua/OpenEdge_latest/abl/class-statement.html , METHOD https://documentation.progress.com/output/ua/OpenEdge_latest/abl/method-statement.html , CONSTRUCTOR https://documentation.progress.com/output/ua/OpenEdge_latest/abl/constructor-statement.html
const ABL_CLASS = ['CLASS acme.Item:', '  CONSTRUCTOR PUBLIC Item ():', '  END CONSTRUCTOR.', '  METHOD PUBLIC INTEGER Count ():', '    RETURN 1.', '  END METHOD.', 'END CLASS.'].join('\n')
// FORMAT-DERIVED: the unit example at https://www.freepascal.org/docs-html/ref/refse112.html
const PASCAL_UNIT = ['unit a;', 'interface', 'procedure Hidden;', 'implementation', 'procedure Hidden;', 'begin', 'end;', 'end.'].join('\n')

let root: string
let project: string
let env: NodeJS.ProcessEnv

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-enterprise-bundle-'))
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
  // The FORMAT-DERIVED fixtures (provenance on their first lines); the RPG member under an uppercase name as IBM i exports write it.
  fs.copyFileSync(path.join(FIXTURES, 'Sample.abap'), path.join(project, 'zdemo.abap'))
  fs.copyFileSync(path.join(FIXTURES, 'Sample.sas'), path.join(project, 'report.sas'))
  fs.copyFileSync(path.join(FIXTURES, 'Sample.pli'), path.join(project, 'payroll.pli'))
  fs.copyFileSync(path.join(FIXTURES, 'Sample.rpgle'), path.join(project, 'CUSTSRV.RPGLE'))
  fs.copyFileSync(path.join(FIXTURES, 'Sample.jcl'), path.join(project, 'PAYJOB.jcl'))
  fs.copyFileSync(path.join(FIXTURES, 'Sample.p'), path.join(project, 'orders.p'))
  fs.writeFileSync(path.join(project, 'Item.cls'), ABL_CLASS)
  fs.writeFileSync(path.join(project, 'legacy.p'), PASCAL_UNIT)
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes ABAP, SAS, PL/I, RPG, JCL and OpenEdge ABL', () => {
  const outlines: Array<[string, string[]]> = [
    ['zdemo.abap', ['zdemo_sales', 'lcl_order', 'total', 'print_line']],
    ['report.sas', ['report', 'work.summary', 'sales']],
    ['payroll.pli', ['Payroll', 'Main', 'Report']],
    ['CUSTSRV.RPGLE', ['MAX_ROWS', 'custRec', 'getName', 'loadName']],
    ['PAYJOB.jcl', ['PAYJOB', 'CARDS', 'PSTEP', 'STEP1', 'STEP2']],
    ['orders.p', ['ttOrder', 'calcTotal', 'addTax']],
    ['Item.cls', ['Item', 'Count']],
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
    ['zdemo.abap', 'total', 'rv_total = 42', 'FORM print_line'],
    ['report.sas', 'report', '%mend report', 'data sales'],
    ['payroll.pli', 'Report', 'B1: BEGIN', 'END Main'],
    ['CUSTSRV.RPGLE', 'loadName', 'begsr loadName', 'return result'],
    ['PAYJOB.jcl', 'STEP1', 'PGM=PAYCALC', 'STEP2'],
    ['orders.p', 'calcTotal', 'FOR EACH ttOrder', 'RETURN pAmount'],
    ['Item.cls', 'Count', 'RETURN 1.', 'CONSTRUCTOR'],
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

  it('leaves a Pascal .p unindexed', () => {
    expect(tg(['symbol', 'Hidden']).stdout).not.toContain('legacy.p')
  })
})

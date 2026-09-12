/**
 * Built-bundle check for the VHDL adapter: the shipped dist/token-goat.mjs, not source, indexes a
 * small VHDL project and answers `symbol`, `read` and `outline` from it. This is the only test
 * that proves the adapter survived bundling and is reached from the real CLI path.
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vhdl-bundle-'))
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
  // FORMAT-DERIVED: IEEE Std 1076-2008 clauses 3.2 (entity_declaration), 3.3 (architecture_body).
  // The `/* ... */` comment is a VHDL-2008 delimited comment (clause 15.9), which does NOT nest.
  fs.writeFileSync(
    path.join(project, 'counter.vhd'),
    [
      'library ieee;',
      'use ieee.std_logic_1164.all;',
      '',
      '/* a one-bit toggle, per 1076-2008 15.9 this comment does not nest */',
      'entity toggle is',
      '  port (',
      '    clk : in  std_logic;',
      '    q   : out std_logic',
      '  );',
      'end entity toggle;',
      '',
      'architecture rtl of toggle is',
      '  signal state : std_logic := \'0\';',
      'begin',
      '  q <= state;',
      '',
      '  flip : process (clk) is',
      '  begin',
      '    if rising_edge(clk) then',
      '      state <= not state;',
      '    end if;',
      '  end process flip;',
      'end architecture rtl;',
      '',
    ].join('\n'),
  )
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes VHDL', () => {
  it('resolves the entity and architecture with symbol', () => {
    const sym = tg(['symbol', 'toggle'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('counter.vhd')
    expect(sym.stdout).toMatch(/entity/i)
  })

  it('reads the architecture body with read, including the process it contains', () => {
    const read = tg(['read', 'counter.vhd::rtl'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('architecture rtl of toggle is')
    expect(read.stdout).toContain('flip : process (clk) is')
    expect(read.stdout).toContain('end architecture rtl;')
  })

  it('outlines the file showing entity and architecture as separate symbols', () => {
    const outline = tg(['outline', 'counter.vhd'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('toggle')
    expect(outline.stdout).toContain('rtl')
  })
})

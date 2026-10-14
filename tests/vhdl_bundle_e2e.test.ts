/** Built-bundle check for the VHDL adapter: the shipped dist/token-goat.mjs, not source, indexes a small VHDL project and answers `symbol`, `read` and `outline` from it. This is the only test that proves the adapter survived bundling and is reached from the real CLI path. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject } from './helpers/bundle.js'

let root: string
let project: string
let env: NodeJS.ProcessEnv

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return bundleTg(project, env, args)
}

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-vhdl-bundle-'))
  // FORMAT-DERIVED: IEEE Std 1076-2008 clauses 3.2 (entity_declaration), 3.3 (architecture_body). The `/* ... */` comment is a VHDL-2008 delimited comment (clause 15.9), which does NOT nest.
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

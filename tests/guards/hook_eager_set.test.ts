/**
 * The hook bundle's eager set is a silent, easily-reversed cost.
 *
 * V8 compiles a module in full before running any of it, so every static import reachable from
 * hook_lib.ts is parsed on every hook invocation whether or not the hook calls into it. A single
 * small helper imported from a large module drags that module's whole transitive graph along:
 * index_health.ts importing a 13-line fs helper from text_commands.ts, and hooks_session_start.ts
 * importing one check from cli_doctor.ts, together put read_commands.ts, graph_commands.ts,
 * js-yaml and fflate on the hook path -- 0.95 MB across 19 inputs, for nothing. Re-adding either
 * import is a one-line change that no behavioural test would notice, so the edges are pinned here.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const src = (f: string): string => fs.readFileSync(path.join(process.cwd(), 'src', f), 'utf8')

describe('hook eager set', () => {
  const forbidden: Array<[string, string]> = [
    ['index_health.ts', './text_commands.js'],
    ['hooks_session_start.ts', './cli_doctor.js'],
  ]

  for (const [file, spec] of forbidden) {
    it(`${file} does not import ${spec}`, () => {
      expect(src(file)).not.toContain(spec)
    })
  }

  it('symbol_body_probe.ts reads the body cap from constants, not parser', () => {
    // parser.ts re-exports the same number as MAX_SYMBOL_BODY_CHARS, but it is 142 KB of
    // extractors this check never calls, and importing it here would put the module back on the
    // hook path it exists to keep off.
    const probe = src('symbol_body_probe.ts')
    expect(probe).toContain("from './constants.js'")
    expect(probe).not.toContain("from './parser.js'")
  })

  it('walk_mode.ts pulls in nothing but node builtins and project.ts', () => {
    const imports = [...src('walk_mode.ts').matchAll(/^import .*? from '(.+?)'/gm)].map((m) => m[1])
    expect(imports.sort()).toEqual(['./project.js', 'fs', 'path'])
  })

  it('doctor_result.ts is value-free so its consumers add no runtime edge', () => {
    expect(src('doctor_result.ts')).not.toMatch(/^(import|export const|export function)\s/m)
  })
})

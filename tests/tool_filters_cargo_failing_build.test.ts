import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CargoFilter } from '../src/tool_filters/build.js'

// CAPTURE: tests/fixtures/tool_output/cargo-1.94.0-build-failing-38-warnings.txt is the stderr of a real `cargo build` (exit 101) over a throwaway crate: 40 `fn unused_N() { let vN = N; }` functions (38 unused-variable warnings), an E0308 on line 22 and an E0425 on line 37 (see PROVENANCE.tsv).
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'tool_output', 'cargo-1.94.0-build-failing-38-warnings.txt'), 'utf8')

const f = new CargoFilter()

// Lines read straight off the fixture: the error diagnostics the compressed body must never lose.
const MUST_KEEP = [
  'error[E0308]: mismatched types',
  '22 | fn unused_20() { let v20: u8 = "x"; }',
  '   |                           --   ^^^ expected `u8`, found `&str`',
  '   |                           expected due to this',
  'error[E0425]: cannot find value `nope_35` in this scope',
  '37 | fn unused_35() { let v35 = nope_35; }',
  '   |                            ^^^^^^^ not found in this scope',
  'error: could not compile `rproj` (bin "rproj") due to 2 previous errors; 38 warnings emitted',
]

describe('CargoFilter on a failing build', () => {
  it('keeps every error block whole and collapses the warning blocks', () => {
    const out = f.apply('', FIXTURE, 101, ['cargo', 'build']).text
    for (const line of MUST_KEEP) expect(out).toContain(line)
    expect(out).not.toContain('unused variable')
    expect(out).not.toContain('_v39')
    expect(out).toContain('collapsed 38 warning block(s)')
    expect(out.length).toBeLessThan(FIXTURE.length * 0.4)
  })

  it('also collapses warnings when the exit code is not forwarded (cargo test compile path)', () => {
    const out = f.apply('', FIXTURE, 0, ['cargo', 'test']).text
    for (const line of MUST_KEEP) expect(out).toContain(line)
    expect(out).not.toContain('_v39')
  })

  it('keeps warnings on a successful build', () => {
    const ok = '   Compiling rproj v0.1.0 (x)\nwarning: unused variable: `v1`\n --> src/main.rs:2:20\n  |\n2 | fn a() { let v1 = 1; }\n  |              ^^ help: prefix: `_v1`\n\nwarning: `rproj` (bin "rproj") generated 1 warning\n    Finished `dev` profile in 0.1s\n'
    const out = f.apply('', ok, 0, ['cargo', 'build']).text
    expect(out).toContain('unused variable: `v1`')
    expect(out).not.toContain('collapsed')
  })
})

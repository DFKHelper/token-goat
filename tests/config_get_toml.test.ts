import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runConfigGet } from '../src/read_inspect.js'

// PROVENANCE: FORMAT-DERIVED from the TOML 1.0 spec (https://toml.io/en/v1.0.0): "Arrays can span multiple lines", multi-line basic strings ("A newline immediately following the opening delimiter will be trimmed"), dotted keys, inline tables. The [tool.ruff] lint.select shape is CAPTURE-shaped from ruff's documented pyproject.toml configuration (https://docs.astral.sh/ruff/configuration/).
const TOML = [
  '[project]',
  'dependencies = [',
  '  "requests>=2",',
  '  "click",',
  ']',
  'description = """',
  'multi',
  'line"""',
  'name = "goat"',
  '',
  '[tool.ruff]',
  'lint.select = ["E", "F"]',
  'server = { host = "x" }',
  '',
].join('\n')

describe('config-get on TOML values the line scan could not read whole', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function run(content: string, key: string): { code: number; out: string; err: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cfgtoml-'))
    dirs.push(dir)
    const file = path.join(dir, 'pyproject.toml')
    writeFileSync(file, content, 'utf-8')
    let out = ''
    let err = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true }) as typeof process.stdout.write)
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true }) as typeof process.stderr.write)
    const code = runConfigGet({ file, key })
    vi.restoreAllMocks()
    return { code, out, err }
  }

  it('prints a multi-line array whole', () => {
    const r = run(TOML, 'project.dependencies')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual(['requests>=2', 'click'])
  })

  it('prints a multi-line basic string decoded, without the newline after the opening delimiter', () => {
    const r = run(TOML, 'project.description')
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe('multi\nline')
  })

  it('resolves a dotted key written inside a table', () => {
    const r = run(TOML, 'tool.ruff.lint.select')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual(['E', 'F'])
  })

  it('resolves a member of an inline table', () => {
    const r = run(TOML, 'tool.ruff.server.host')
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe('x')
  })

  it('still reads a plain scalar and reports a missing key in a valid file', () => {
    expect(run(TOML, 'project.name').out.trim()).toBe('goat')
    const miss = run(TOML, 'project.nope')
    expect(miss.code).toBe(1)
    expect(miss.err).toContain('not found')
  })

  it('refuses with exit 1 instead of printing a fragment when the file is not valid TOML', () => {
    // HAND-DERIVED: an unterminated array makes the file invalid TOML, so only the line scan can see the key, and it sees `[`.
    const r = run('[project]\ndependencies = [\n  "requests>=2",\n', 'project.dependencies')
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toContain('cannot be read whole')
  })
})

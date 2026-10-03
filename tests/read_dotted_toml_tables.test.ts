/** A key under a dotted TOML table (`[tool.ruff]`, `[dependencies.serde]`) must resolve by its dotted chain, and every qualified retry an ambiguity refusal prints must resolve. Before, the spec was split on every `.` while the table is one symbol named `tool.ruff`, so the refusal suggested `pyproject.toml::tool.ruff.line-length` and that spec then missed. Driven through real indexing (indexFileSync into the isolated global index), the real runRead and the real brief core. Provenance: CAPTURE for the refusal and retry text (the built bundle's `read pyproject.toml::line-length` on this exact fixture printed `tool.black.line-length (line 5)` and `tool.ruff.line-length (line 8)`); HAND-DERIVED for the line numbers and values, which follow from the fixture text alone. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { runBriefCore } from '../src/read_brief.js'
import { runRead } from '../src/read_commands.js'

const PYPROJECT = ['[project]', 'name = "demo"', '', '[tool.black]', 'line-length = 100', '', '[tool.ruff]', 'line-length = 120', ''].join('\n')
const CARGO = ['[dependencies.serde]', 'version = "1"', '[dependencies.tokio]', 'version = "1.40"', ''].join('\n')

let dir: string
let origCwd: string

beforeEach(() => {
  origCwd = process.cwd()
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dottoml-')))
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), PYPROJECT)
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), CARGO)
  for (const f of ['pyproject.toml', 'Cargo.toml']) indexFileSync(path.join(dir, f), globalDbPath())
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(origCwd)
  closeAllDbs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('keys under a dotted TOML table', () => {
  it('reads the full dotted spelling', () => {
    const r = runRead({ spec: 'pyproject.toml::tool.ruff.line-length', projectRoot: dir })
    expect(r.code).toBe(0)
    expect(r.text).toContain('line-length = 120')
    expect(r.text).not.toContain('= 100')
  })

  it('reads a suffix of the dotted chain', () => {
    const r = runRead({ spec: 'pyproject.toml::ruff.line-length', projectRoot: dir })
    expect(r.code).toBe(0)
    expect(r.text).toContain('line-length = 120')
  })

  it('reads a Cargo key under [dependencies.tokio]', () => {
    for (const spec of ['Cargo.toml::dependencies.tokio.version', 'Cargo.toml::tokio.version']) {
      const r = runRead({ spec, projectRoot: dir })
      expect(r.code).toBe(0)
      expect(r.text).toContain('version = "1.40"')
      expect(r.text).not.toContain('version = "1"')
    }
  })

  it('misses a chain naming no such table', () => {
    expect(runRead({ spec: 'pyproject.toml::tool.mypy.line-length', projectRoot: dir }).code).toBe(1)
    expect(runRead({ spec: 'pyproject.toml::black.line-length', projectRoot: dir }).code).toBe(0)
  })

  it('brief resolves the dotted spelling too', () => {
    const r = runBriefCore({ spec: 'pyproject.toml::tool.ruff.line-length', projectRoot: dir })
    expect(r.code).toBe(0)
    expect(r.text).toContain('line-length = 120')
  })

  it('every qualified retry an ambiguity refusal prints resolves to its own key', () => {
    const refusal = runRead({ spec: 'pyproject.toml::line-length', projectRoot: dir })
    expect(refusal.code).toBe(1)
    const retries = [...refusal.text.matchAll(/token-goat read "([^"]+)"/g)].map((m) => m[1]!)
    expect(retries).toHaveLength(2)
    const values: string[] = []
    for (const spec of retries) {
      const r = runRead({ spec, projectRoot: dir })
      expect(r.code, spec).toBe(0)
      values.push(r.text)
    }
    expect(values.some((t) => t.includes('= 100'))).toBe(true)
    expect(values.some((t) => t.includes('= 120'))).toBe(true)
  })
})

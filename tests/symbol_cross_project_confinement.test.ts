/**
 * `symbol` is the one read command that queries the machine-wide `global.db` by default, so from
 * any indexed directory `symbol <name>` (and `symbol --grep .`) returns rows -- bodies included --
 * from every project ever indexed on the host. That is documented behavior and useful on a
 * personal machine; on a shared or agent-driven one it is a disclosure channel that a directory
 * sandbox around the agent does not close, because the answer comes from the index rather than
 * from the filesystem.
 *
 * `indexing.cross_project_symbols = false` confines the command to the project it runs from.
 * These tests pin both halves: the default still reaches across projects (the documented
 * behavior, mirrored in read_cross_project_relative_spec.test.ts), and with the setting off the
 * other project's symbol is unreachable -- including via the two arguments that would otherwise
 * re-open the channel from inside the confined process, `--project` and an absolute `--file`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_commands.js'

let rootA: string
let rootB: string
let cwdSpy: ReturnType<typeof vi.spyOn>

/** Writes `src/thing.ts` under `root` with a uniquely-named, marker-bearing symbol and indexes it. */
function seedProject(root: string, symbolName: string, marker: string): string {
  const dir = path.join(root, 'src')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'thing.ts')
  fs.writeFileSync(file, `export function ${symbolName}(): string {\n  return '${marker}'\n}\n`)
  indexFileSync(normalizePath(file), globalDbPath())
  return file
}

/** Turns the confinement on for the duration of one test. */
function confine(): void {
  process.env['TOKEN_GOAT_CROSS_PROJECT_SYMBOLS'] = 'false'
  invalidateConfigCache()
}

beforeEach(() => {
  rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-confine-a-')))
  rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-confine-b-')))
  seedProject(rootA, 'alphaOwnSymbol', 'AAA-FROM-PROJECT-A')
  seedProject(rootB, 'betaSecretForecast', 'BBB-CONFIDENTIAL-FROM-PROJECT-B')
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
})

afterEach(() => {
  delete process.env['TOKEN_GOAT_CROSS_PROJECT_SYMBOLS']
  invalidateConfigCache()
  cwdSpy.mockRestore()
  closeAllDbs()
  fs.rmSync(rootA, { recursive: true, force: true })
  fs.rmSync(rootB, { recursive: true, force: true })
})

describe('symbol with indexing.cross_project_symbols left at its default', () => {
  it("reaches the other project's symbol and body", () => {
    const { text, code } = runSymbol({ name: 'betaSecretForecast' })
    expect(code, text).toBe(0)
    expect(text).toContain('BBB-CONFIDENTIAL-FROM-PROJECT-B')
  })

  it('enumerates the other project via --grep', () => {
    const { text, code } = runSymbol({ grep: '.', limit: 500 })
    expect(code, text).toBe(0)
    expect(text).toContain('betaSecretForecast')
  })
})

describe('symbol with indexing.cross_project_symbols = false', () => {
  it("no longer resolves the other project's symbol by name", () => {
    confine()
    const { text, code } = runSymbol({ name: 'betaSecretForecast' })
    expect(code).toBe(1)
    expect(text).not.toContain('BBB-CONFIDENTIAL-FROM-PROJECT-B')
  })

  it('still resolves a symbol belonging to the project it runs from', () => {
    confine()
    const { text, code } = runSymbol({ name: 'alphaOwnSymbol' })
    expect(code, text).toBe(0)
    expect(text).toContain('AAA-FROM-PROJECT-A')
  })

  it('no longer enumerates other projects via --grep', () => {
    confine()
    const { text, code } = runSymbol({ grep: '.', limit: 500 })
    expect(code, text).toBe(0)
    expect(text).toContain('alphaOwnSymbol')
    expect(text).not.toContain('betaSecretForecast')
  })

  it('refuses a --project pointing outside the confining root instead of honoring it', () => {
    confine()
    const { text, code } = runSymbol({ name: 'betaSecretForecast', projectRoot: rootB })
    expect(code).toBe(1)
    expect(text).toContain('--project is outside this project root')
    expect(text).not.toContain('BBB-CONFIDENTIAL-FROM-PROJECT-B')
  })

  it('refuses an absolute --file pointing outside the confining root', () => {
    confine()
    const { text, code } = runSymbol({ name: 'betaSecretForecast', file: path.join(rootB, 'src', 'thing.ts') })
    expect(code).toBe(1)
    expect(text).toContain('--file is outside this project root')
    expect(text).not.toContain('BBB-CONFIDENTIAL-FROM-PROJECT-B')
  })

  it('still accepts a --project and a --file inside the confining root', () => {
    confine()
    const { text, code } = runSymbol({ name: 'alphaOwnSymbol', projectRoot: rootA, file: path.join(rootA, 'src', 'thing.ts') })
    expect(code, text).toBe(0)
    expect(text).toContain('AAA-FROM-PROJECT-A')
  })

  // A sibling directory whose path merely starts with the confining root's string is a different
  // project: without the trailing-separator guard in isInsideRoot, `<rootA>-evil` would read as
  // inside `<rootA>` and the refusal would not fire.
  it('refuses a sibling root that shares the confining root as a string prefix', () => {
    confine()
    const sibling = `${rootA}-evil`
    fs.mkdirSync(sibling, { recursive: true })
    try {
      const { text, code } = runSymbol({ name: 'alphaOwnSymbol', projectRoot: sibling })
      expect(code).toBe(1)
      expect(text).toContain('--project is outside this project root')
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true })
    }
  })
})

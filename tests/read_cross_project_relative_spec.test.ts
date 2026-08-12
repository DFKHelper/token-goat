/**
 * `global.db` is a single machine-wide index keyed by ABSOLUTE path across every project ever
 * indexed (see constants.ts), so two unrelated projects can both hold `src/thing.ts::sharedName`.
 * A raised concern was that `read` with a bare relative spec might therefore serve the wrong
 * project's copy. It does not: `resolveIndexPath` (src/paths.ts) resolves the relative file
 * against the base (cwd by default) into an absolute key BEFORE the exact-equality lookup, so
 * the two projects' rows never collide.
 *
 * Nothing asserted that, though, and the guarantee rests entirely on resolution happening before
 * the lookup rather than on the lookup itself -- exactly the shape that broke repeatedly in the
 * MCP confinement layer, where a check and its use drifted apart. These tests pin it: the same
 * relative spec, run from two different projects, must return each project's own file.
 *
 * The bare-NAME case is deliberately the opposite and is pinned here too: `symbol <name>` with no
 * file is a machine-wide lookup that legitimately returns rows from other projects, each labelled
 * with its absolute path (see toDisplayPath's docblock in src/paths.ts). That is documented
 * behavior, not leakage, and a future change narrowing it should have to update this test on
 * purpose rather than silently.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runRead, runSymbol } from '../src/read_commands.js'

let rootA: string
let rootB: string
let cwdSpy: ReturnType<typeof vi.spyOn>

/** Writes `src/thing.ts` under `root` with a marker-bearing body and indexes it. */
function seedProject(root: string, marker: string): void {
  const dir = path.join(root, 'src')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'thing.ts')
  fs.writeFileSync(file, `export function sharedName(): string {\n  return '${marker}'\n}\n`)
  indexFileSync(normalizePath(file), globalDbPath())
}

beforeEach(() => {
  rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xproj-a-')))
  rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xproj-b-')))
  seedProject(rootA, 'AAA-FROM-PROJECT-A')
  seedProject(rootB, 'BBB-FROM-PROJECT-B')
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
})

afterEach(() => {
  cwdSpy.mockRestore()
  closeAllDbs()
  fs.rmSync(rootA, { recursive: true, force: true })
  fs.rmSync(rootB, { recursive: true, force: true })
})

describe('read with a relative spec shared by two indexed projects', () => {
  it("serves the current project's file, not the other project's same-named one", () => {
    const { text, code } = runRead({ spec: 'src/thing.ts::sharedName' })
    expect(code, text).toBe(0)
    expect(text).toContain('AAA-FROM-PROJECT-A')
    expect(text).not.toContain('BBB-FROM-PROJECT-B')
  })

  it("serves the OTHER project's file for the identical spec once cwd moves there", () => {
    cwdSpy.mockReturnValue(rootB)
    const { text, code } = runRead({ spec: 'src/thing.ts::sharedName' })
    expect(code, text).toBe(0)
    expect(text).toContain('BBB-FROM-PROJECT-B')
    expect(text).not.toContain('AAA-FROM-PROJECT-A')
  })

  it('honors an explicit projectRoot over cwd for the same relative spec', () => {
    const { text, code } = runRead({ spec: 'src/thing.ts::sharedName', projectRoot: rootB })
    expect(code, text).toBe(0)
    expect(text).toContain('BBB-FROM-PROJECT-B')
    expect(text).not.toContain('AAA-FROM-PROJECT-A')
  })

  // Documented counterpart: a bare name carries no file to resolve, so the machine-wide index answers with every project's match, each labelled by absolute path. Narrowing this later should be a deliberate edit to this expectation, not a silent behavior change.
  it('still answers a bare symbol name from every indexed project, labelled by absolute path', () => {
    const { text, code } = runSymbol({ name: 'sharedName' })
    expect(code, text).toBe(0)
    expect(text).toContain('AAA-FROM-PROJECT-A')
    expect(text).toContain('BBB-FROM-PROJECT-B')
    expect(text).toContain(normalizePath(path.join(rootB, 'src', 'thing.ts')))
  })
})

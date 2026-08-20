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
import { runScope } from '../src/graph_commands.js'
import { runBrief, runExports, runOutline, runRead, runRefs, runSkeleton, runSymbol } from '../src/read_commands.js'

import { captureStdout } from './helpers/capture-stdout.js'

let rootA: string
let rootB: string
let cwdSpy: ReturnType<typeof vi.spyOn>

/** Writes `src/thing.ts` under `root` with a uniquely-named, marker-bearing symbol and indexes it. */
function seedProject(root: string, symbolName: string, marker: string): string {
  const dir = path.join(root, 'src')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'thing.ts')
  fs.writeFileSync(file, `export function ${symbolName}(): string {\n  return '${marker}'\n}\nexport function ${symbolName}Caller(): string {\n  return ${symbolName}()\n}\n`)
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


/**
 * Runs an emitting command, returning its exit code alongside everything it wrote to stdout AND
 * stderr. Both streams matter here: a refusal goes to stderr via emitErr, while the content a
 * leak would disclose goes to stdout -- asserting on only one of them would let a test pass
 * either by missing the refusal or by missing the leak.
 */
function captureStdoutCode(fn: () => number): { code: number; text: string } {
  let code = 0
  let err = ''
  const origErr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') err += chunk
    return (origErr as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  let out: string
  try {
    out = captureStdout(() => {
      code = fn()
    })
  } finally {
    process.stderr.write = origErr
  }
  return { code, text: out + err }
}

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

/**
 * `symbol` was the only command enforcing the confinement, but it is not the only one that
 * answers out of the shared index: `read`, `brief`, `skeleton`, `outline` and `exports` all take
 * a caller-supplied path and serve whatever the index holds for it. Proven by deleting the other
 * project from disk first -- anything still returned cannot have come from the filesystem, which
 * is exactly the channel a directory sandbox cannot close and the setting exists to close.
 */
describe('the other index-backed read commands with cross_project_symbols = false', () => {
  let bFile: string

  beforeEach(() => {
    bFile = path.join(rootB, 'src', 'thing.ts')
    // Remove project B from disk entirely: no filesystem read can succeed from here on.
    fs.rmSync(rootB, { recursive: true, force: true })
    confine()
  })

  const SPEC = (): string => `${bFile}::betaSecretForecast`

  it('read refuses a spec pointing at the other project', () => {
    const { text, code } = runRead({ spec: SPEC() })
    expect(code).toBe(1)
    expect(text).toContain('confines symbol lookups to it')
    expect(text).not.toContain('BBB-CONFIDENTIAL-FROM-PROJECT-B')
  })

  it('brief refuses a spec pointing at the other project', () => {
    const { code, text } = captureStdoutCode(() => runBrief({ spec: SPEC() }))
    expect(code).toBe(1)
    expect(text).toContain('confines symbol lookups to it')
    expect(text).not.toContain('BBB-CONFIDENTIAL-FROM-PROJECT-B')
  })

  it('skeleton refuses a file in the other project', () => {
    const { text, code } = runSkeleton({ file: bFile })
    expect(code).toBe(1)
    expect(text).toContain('confines symbol lookups to it')
    expect(text).not.toContain('betaSecretForecast')
  })

  it('outline refuses a file in the other project', () => {
    const { text, code } = runOutline({ file: bFile })
    expect(code).toBe(1)
    expect(text).toContain('confines symbol lookups to it')
    expect(text).not.toContain('betaSecretForecast')
  })

  it('exports refuses a file in the other project', () => {
    const { code, text } = captureStdoutCode(() => runExports({ file: bFile }))
    expect(code).toBe(1)
    expect(text).toContain('confines symbol lookups to it')
    expect(text).not.toContain('betaSecretForecast(')
  })
})

describe('the other index-backed read commands still serve their own project', () => {
  const own = (): string => path.join(rootA, 'src', 'thing.ts')

  it('read, skeleton and outline all answer for a file inside the confining root', () => {
    confine()
    const read = runRead({ spec: `${own()}::alphaOwnSymbol` })
    expect(read.code, read.text).toBe(0)
    expect(read.text).toContain('AAA-FROM-PROJECT-A')
    const skeleton = runSkeleton({ file: own() })
    expect(skeleton.code, skeleton.text).toBe(0)
    expect(skeleton.text).toContain('alphaOwnSymbol')
    const outline = runOutline({ file: own() })
    expect(outline.code, outline.text).toBe(0)
    expect(outline.text).toContain('alphaOwnSymbol')
  })

  // The confinement is opt-in: with the setting left at its default these commands must still
  // reach the other project, the same documented behavior the `symbol` cases above pin.
  it('read still reaches the other project when the setting is left at its default', () => {
    const { text, code } = runRead({ spec: `${path.join(rootB, 'src', 'thing.ts')}::betaSecretForecast` })
    expect(code, text).toBe(0)
    expect(text).toContain('BBB-CONFIDENTIAL-FROM-PROJECT-B')
  })
})

/**
 * `scope` and `refs` answer out of the same index but were missed by the first sweep because
 * neither takes a `file::symbol` spec through the shared resolver: `scope` takes `file:line` and
 * renders the enclosing symbol's full body under `--json`, and `refs` searches the whole index by
 * symbol NAME, so an unscoped query returns reference sites -- path, line, and the surrounding
 * source context -- from every project on the machine.
 */
describe('scope and refs with cross_project_symbols = false', () => {
  it('scope refuses a file:line in the other project instead of rendering its body', () => {
    confine()
    const { code, text } = captureStdoutCode(() => runScope({ spec: `${path.join(rootB, 'src', 'thing.ts')}:2`, json: true }))
    expect(code).toBe(1)
    expect(text).toContain('confines symbol lookups to it')
    expect(text).not.toContain('BBB-CONFIDENTIAL-FROM-PROJECT-B')
  })

  it('scope still answers for a file inside the confining root', () => {
    confine()
    const { code, text } = captureStdoutCode(() => runScope({ spec: `${path.join(rootA, 'src', 'thing.ts')}:2` }))
    expect(code, text).toBe(0)
    expect(text).toContain('alphaOwnSymbol')
  })

  it('refs refuses a spec whose file is in the other project', () => {
    confine()
    const { code, text } = captureStdoutCode(() => runRefs({ spec: `${path.join(rootB, 'src', 'thing.ts')}::betaSecretForecast` }))
    expect(code).toBe(1)
    expect(text).toContain('confines symbol lookups to it')
    expect(text).not.toContain('betaSecretForecastCaller')
  })

  it('refs refuses a --project pointing outside the confining root', () => {
    confine()
    const { code, text } = captureStdoutCode(() => runRefs({ spec: 'betaSecretForecast', projectRoot: rootB }))
    expect(code).toBe(1)
    expect(text).toContain('--project is outside this project root')
    expect(text).not.toContain('betaSecretForecastCaller')
  })

  // The bare-name form names no file at all, so it cannot be gated by a path: it is confined by
  // scoping the query to the confining root, the same way `symbol`'s bare-name path is.
  it('refs by bare name no longer reaches the other project, and still finds its own', () => {
    confine()
    const other = captureStdoutCode(() => runRefs({ spec: 'betaSecretForecast' }))
    expect(other.text).not.toContain('betaSecretForecastCaller')
    const own = captureStdoutCode(() => runRefs({ spec: 'alphaOwnSymbol' }))
    expect(own.code, own.text).toBe(0)
    expect(own.text).toContain('alphaOwnSymbolCaller')
  })

  it('refs by bare name still reaches the other project when the setting is left at its default', () => {
    const { code, text } = captureStdoutCode(() => runRefs({ spec: 'betaSecretForecast' }))
    expect(code, text).toBe(0)
    expect(text).toContain('betaSecretForecastCaller')
  })
})

/**
 * `refs`, `ask`, `semantic`, and `trace --bodies` must warn (and self-heal) when the rows they
 * answer from are stale, the same way `symbol`/`read`/`skeleton`/`outline` already did.
 *
 * `staleWarning`/`healStaleIndex` (read_commands.ts) existed and were wired into exactly those
 * four single-file commands. `refs`, `ask`, and `semantic` answer from however many distinct files
 * their query happens to match -- none of which the caller named as a single spec -- and `trace
 * --bodies` resolves a traceback frame's file the same way `symbol`/`read` resolve a spec's file,
 * yet had no staleness check of its own at all. Before this fix, editing a file on disk (without
 * going through the edit hook / dirty-queue) left every one of these four commands silently
 * serving the pre-edit rows with no warning and no self-heal -- exactly the trap
 * `read_commands_stale_self_heal_e2e.test.ts` already covers for the other four commands.
 *
 * Driven through the REAL registered command functions (`runRefs`, `runAsk`, `runSemantic`,
 * `cmdTrace`) against a real, unmocked index built with `indexFileSync` -- same discipline as
 * `read_commands_stale_self_heal_e2e.test.ts` and `trace_bodies_e2e.test.ts`. `runAsk`'s backend
 * spawn (codex/claude, neither installed here) is the one thing stubbed, since this is not a test
 * of the backend integration and `warnIfFilesStale` runs before that spawn regardless of its
 * outcome.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ChildProcess from 'node:child_process'

// `runAsk`'s backend spawn is the only thing this file needs to fake -- but `spawnSync` is also
// how `src/util.ts::runGit` resolves the project root (`git rev-parse --show-toplevel`), and
// `resolveProjectRoot` runs on every one of these commands to scope their DB queries. A blanket
// fake broke `runAsk`/`runSemantic`/`cmdTrace --bodies` silently: `runGit` read the fake
// `{status: 0, stdout: 'answer'}` as a real git toplevel of `answer`, so `resolveProjectRoot`
// scoped the query to a bogus root and every real hit vanished with no error -- confirmed by
// diffing this test's real-`spawnSync` debug run against the faked one. Only fake the call whose
// first argument is not `git`, so `runGit`'s own spawn passes straight through to the real binary.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  const realSpawnSync = actual.spawnSync
  return {
    ...actual,
    execFileSync: vi.fn(() => (process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe\n' : '/bin/echo\n')),
    spawnSync: vi.fn((command: unknown, args?: unknown, options?: unknown) => {
      if (command === 'git') return (realSpawnSync as (...a: unknown[]) => unknown)(command, args, options)
      return { status: 0, stdout: 'answer', stderr: '', pid: 1, output: [], signal: null }
    }),
  }
})

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { getFileEntry } from '../src/index_reader.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { runRefs, runSemantic } from '../src/read_commands.js'
import { runAsk } from '../src/graph_commands.js'
import { cmdTrace } from '../src/text_commands.js'

let root: string
let origCwd: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-stale-multi-'))
  origCwd = process.cwd()
  process.chdir(root)
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  process.chdir(origCwd)
  rmSync(root, { recursive: true, force: true })
  warnSpy.mockRestore()
  vi.restoreAllMocks()
})

function capturedWarnings(): string {
  return warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
}

describe('stale-index warning reaches multi-file answer commands', () => {
  it('runRefs warns and self-heals when the referenced file changed out of band', () => {
    const defFile = join(root, 'refstale_def9k.ts')
    const callerFile = join(root, 'refstale_caller9k.ts')
    writeFileSync(defFile, 'export function refStaleTarget9k(): number {\n  return 1\n}\n')
    writeFileSync(callerFile, "import { refStaleTarget9k } from './refstale_def9k.js'\nrefStaleTarget9k()\n")
    indexFileSync(normalizePath(defFile))
    indexFileSync(normalizePath(callerFile))

    // Genuine staleness: edit the CALLING file directly on disk, bypassing the dirty queue, so
    // its row's sha no longer matches its current bytes.
    writeFileSync(callerFile, "import { refStaleTarget9k } from './refstale_def9k.js'\n// touched\nrefStaleTarget9k()\n")

    const code = runRefs({ spec: `${defFile}::refStaleTarget9k` })
    expect(code).toBe(0)
    expect(capturedWarnings(), 'refs served a stale caller row with no warning').toMatch(/changed on disk/)

    const resolvedCaller = normalizePath(callerFile)
    expect(getFileEntry(resolvedCaller)?.sha).toBe(fingerprintFile(resolvedCaller))
  })

  it('runAsk warns and self-heals when a matched file changed out of band', () => {
    const file = join(root, 'askstale9k.ts')
    writeFileSync(file, 'export function askStaleUniqueTerm9k(): number {\n  return 1\n}\n')
    indexFileSync(normalizePath(file))

    writeFileSync(file, 'export function askStaleUniqueTerm9k(): number {\n  return 2\n}\n')

    runAsk({ question: 'askStaleUniqueTerm9k' })
    expect(capturedWarnings(), 'ask served a stale row with no warning').toMatch(/changed on disk/)

    const resolved = normalizePath(file)
    expect(getFileEntry(resolved)?.sha).toBe(fingerprintFile(resolved))
  })

  it('runSemantic (FTS fallback, no embedding model needed) warns and self-heals for a stale hit', async () => {
    const file = join(root, 'semanticstale9k.ts')
    writeFileSync(file, 'export function semanticStaleUniqueTerm9k(): number {\n  return 1\n}\n')
    indexFileSync(normalizePath(file))

    writeFileSync(file, 'export function semanticStaleUniqueTerm9k(): number {\n  return 2\n}\n')

    const { code } = await runSemantic('semanticStaleUniqueTerm9k', {})
    expect(code).toBe(0)
    expect(capturedWarnings(), 'semantic served a stale hit with no warning').toMatch(/changed on disk/)

    const resolved = normalizePath(file)
    expect(getFileEntry(resolved)?.sha).toBe(fingerprintFile(resolved))
  })

  it('cmdTrace --bodies warns and self-heals a frame file that changed out of band', () => {
    const modFile = join(root, 'tracestale9k.py')
    writeFileSync(modFile, 'def traceStaleHelper9k():\n    x = 1\n    return x\n')
    indexFileSync(normalizePath(modFile))

    writeFileSync(modFile, 'def traceStaleHelper9k():\n    x = 2\n    return x\n')

    const tbFile = join(root, 'tb.txt')
    writeFileSync(
      tbFile,
      ['Traceback (most recent call last):', `  File "${modFile}", line 3, in traceStaleHelper9k`, '    return x', 'ValueError: bad'].join('\n') + '\n',
    )

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      cmdTrace(tbFile, { bodies: true })
    } finally {
      stdoutSpy.mockRestore()
    }
    expect(capturedWarnings(), 'trace --bodies served a stale frame body with no warning').toMatch(/changed on disk/)

    const resolved = normalizePath(modFile)
    expect(getFileEntry(resolved)?.sha).toBe(fingerprintFile(resolved))
  })
})

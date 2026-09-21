/**
 * Batch Q — recognizing a plain-enumeration rg/grep structural search on the Bash path and
 * rewriting it to the token-goat index command that answers it exactly, instead of running the
 * text search and costing the model a follow-up call.
 *
 * FIXTURE PROVENANCE: every fixture body below is HAND-DERIVED -- written directly for this test
 * from the language's own def/class/import syntax, independent of `src/bash_structural_index.ts`'s
 * own regexes. None of it is copied from that file's matcher, so a fixture that happened to agree
 * with a wrong regex would not silently pass.
 *
 * These are the pass-through cases the batch brief calls out as the ones that keep the feature
 * honest: a context flag, a count flag, a files-only flag, a pipe, a never-indexed target, a
 * stale target, and a language mismatch (`^def ` against a `.ts` file). A suite that only proves
 * the rewrite fires proves nothing about this feature's correctness gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { indexFileSync } from '../src/parser.js'
import { globalDbPath } from '../src/constants.js'
import { getFileEntry } from '../src/index_reader.js'
import { resolveIndexPath } from '../src/paths.js'
import { makeHookEvent } from './helpers/hook-event.js'

const PY_SRC = [
  'import os',
  'import sys',
  '',
  'def helper():',
  '    return 1',
  '',
  'def test_helper():',
  '    assert helper() == 1',
  '',
  'class Widget:',
  '    def render(self):',
  '        return "ok"',
  '',
  'class TestWidget:',
  '    def test_render(self):',
  '        assert Widget().render() == "ok"',
  '',
].join('\n')

const TS_SRC = [
  'import { readFileSync } from "node:fs"',
  '',
  'function helper(): number {',
  '  return 1',
  '}',
  '',
  'export class Widget {',
  '  render(): string { return "ok" }',
  '}',
  '',
].join('\n')

const MD_SRC = [
  '# Title',
  '',
  'Intro text.',
  '',
  '## Section One',
  '',
  'Body.',
  '',
  '## Section Two',
  '',
  'More body.',
  '',
].join('\n')

let TMP = ''
let PY_FILE = ''
let TS_FILE = ''
let MD_FILE = ''
let NEVER_INDEXED_FILE = ''
let STALE_FILE = ''

function bashEvent(command: string, harness?: string): HookEvent {
  return makeHookEvent({
    eventName: 'pre_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 's-structural-index',
    raw: { cwd: TMP, tool_name: 'Bash', tool_input: { command }, ...(harness !== undefined ? { _tg_harness: harness } : {}) },
  })
}

function indexed(filePath: string): void {
  const resolved = resolveIndexPath(filePath, TMP)
  indexFileSync(resolved, globalDbPath())
  expect(getFileEntry(resolved)).not.toBeNull()
}

/** The structural-index-rewritten command, or null when this hook's rewrite did not fire. Keys
 *  on this module's own disclosure marker rather than the bare `rewriteInput` hookType, because
 *  the pre-existing `bash_compress` feature also returns `rewriteInput` for a plain `rg`/`grep`
 *  call it recognizes -- a pass-through case for THIS feature legitimately still gets wrapped by
 *  that unrelated, already-shipped mechanism, and asserting on hookType alone would conflate the
 *  two rewrites. */
function rewrittenCommand(output: ReturnType<typeof preBashHandler>): string | null {
  if (output.hookType !== 'rewriteInput' || typeof output.updatedInput['command'] !== 'string') return null
  const cmd = output.updatedInput['command']
  return cmd.includes('[token-goat: rewrote this rg/grep search to an indexed answer') ? cmd : null
}

beforeAll(() => {
  // Forward-slashed throughout (including TMP itself): these paths are embedded literally into
  // shell command strings below, and a Windows backslash there would collide with the shell's own
  // escape syntax during shlexSplit's quote-aware parsing -- forward slashes work fine as file
  // paths on Windows and sidestep that ambiguity entirely.
  const posix = (p: string): string => p.replace(/\\/g, '/')
  // Resolved with `realpathSync.native` so the base is already the OS's own spelling, the same reason tests/helpers/containment_matrix.ts resolves its base. The rewrite names the path the index holds, and the index holds a canonical one: where `os.tmpdir()` is reached through a Windows 8.3 alias (`C:/Users/RUNNER~1`, which is what GitHub's Windows runner reports) or the macOS `/var` symlink, a TMP taken straight from `mkdtempSync` is a spelling the rewrite never emits, so every assertion below compared two different names for one file.
  TMP = posix(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-structural-index-'))))
  PY_FILE = posix(path.join(TMP, 'service.py'))
  TS_FILE = posix(path.join(TMP, 'service.ts'))
  MD_FILE = posix(path.join(TMP, 'doc.md'))
  NEVER_INDEXED_FILE = posix(path.join(TMP, 'never_indexed.py'))
  STALE_FILE = posix(path.join(TMP, 'stale.py'))
  fs.writeFileSync(PY_FILE, PY_SRC, 'utf-8')
  fs.writeFileSync(TS_FILE, TS_SRC, 'utf-8')
  fs.writeFileSync(MD_FILE, MD_SRC, 'utf-8')
  fs.writeFileSync(NEVER_INDEXED_FILE, PY_SRC, 'utf-8')
  fs.writeFileSync(STALE_FILE, PY_SRC, 'utf-8')

  indexed(PY_FILE)
  indexed(TS_FILE)
  indexed(MD_FILE)
  indexed(STALE_FILE)
  // Modify on disk *after* indexing, without reindexing, so its sha diverges from the index row.
  fs.writeFileSync(STALE_FILE, PY_SRC + '\n# a later edit the index never saw\n', 'utf-8')
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('structural index rewrite -- rewrite cases', () => {
  it('rewrites a whole-file Python def search to outline', () => {
    const out = preBashHandler(bashEvent(`rg '^def ' ${PY_FILE}`))
    const cmd = rewrittenCommand(out)
    expect(cmd).not.toBeNull()
    expect(cmd).toMatch(/^token-goat --notice "/)
    expect(cmd).toContain(`outline ${PY_FILE}`)
    expect(cmd).toContain('[token-goat: rewrote this rg/grep search to an indexed answer')
    expect(cmd).not.toContain('--grep')
  })

  it('rewrites a name-prefixed Python def search (test discovery) to a filtered outline', () => {
    const out = preBashHandler(bashEvent(`rg 'def test_' ${PY_FILE}`))
    const cmd = rewrittenCommand(out)
    expect(cmd).not.toBeNull()
    expect(cmd).toContain(`outline ${PY_FILE} --grep ^test_`)
  })

  it('rewrites a whole-file Python class search to outline', () => {
    const out = preBashHandler(bashEvent(`rg '^class ' ${PY_FILE}`))
    const cmd = rewrittenCommand(out)
    expect(cmd).not.toBeNull()
    expect(cmd).toContain(`outline ${PY_FILE}`)
    expect(cmd).not.toContain('--grep')
  })

  it('rewrites a name-prefixed Python class search to a filtered outline', () => {
    const out = preBashHandler(bashEvent(`rg 'class Test' ${PY_FILE}`))
    const cmd = rewrittenCommand(out)
    expect(cmd).not.toBeNull()
    expect(cmd).toContain(`outline ${PY_FILE} --grep ^Test`)
  })

  it('rewrites an anchored import search to the imports command', () => {
    const out = preBashHandler(bashEvent(`rg '^import' ${PY_FILE}`))
    const cmd = rewrittenCommand(out)
    expect(cmd).not.toBeNull()
    expect(cmd).toContain(`imports ${PY_FILE}`)
  })

  it('rewrites an anchored import search on a TypeScript file to the imports command', () => {
    const out = preBashHandler(bashEvent(`rg '^import' ${TS_FILE}`))
    const cmd = rewrittenCommand(out)
    expect(cmd).not.toBeNull()
    expect(cmd).toContain(`imports ${TS_FILE}`)
  })

  it('rewrites a markdown heading search to outline', () => {
    const out = preBashHandler(bashEvent(`rg '^## ' ${MD_FILE}`))
    const cmd = rewrittenCommand(out)
    expect(cmd).not.toBeNull()
    expect(cmd).toContain(`outline ${MD_FILE}`)
  })

  it('rewrites the quantifier-heading form (rg \'^#{1,3} \') to outline', () => {
    const out = preBashHandler(bashEvent(`rg '^#{1,3} ' ${MD_FILE}`))
    const cmd = rewrittenCommand(out)
    expect(cmd).not.toBeNull()
    expect(cmd).toContain(`outline ${MD_FILE}`)
  })

  // HAND-DERIVED: the invariant this whole batch rests on -- the emitted command is one
  // `token-goat` invocation, with the disclosure printed by its own `--notice` flag rather than
  // shelled out via `echo ... &&`, and its only quoted argument uses double quotes (valid in both
  // a POSIX shell and PowerShell 5.1), never a POSIX-only single-quoted one.
  it('emits a command with no shell chaining operator and no single-quoted argument', () => {
    const out = preBashHandler(bashEvent(`rg 'def test_' ${PY_FILE}`))
    const cmd = rewrittenCommand(out)
    expect(cmd).not.toBeNull()
    expect(cmd).toMatch(/^token-goat --notice "/)
    expect(cmd).not.toMatch(/&&|\|\||[|;]/)
    expect(cmd).not.toContain("'")
  })

  // HAND-DERIVED: `_tg_harness` values `hooks_cli.ts` stamps onto the payload for each bridge
  // (see src/hooks_cli.ts::result['_tg_harness']). Before this batch, `detectStructuralIndexRewrite`
  // returned null for all three on this platform (win32) -- see the removed guard this test
  // replaces coverage for.
  describe('fires on every harness now that the command is shell-agnostic', () => {
    it.each(['vscode', 'codex', 'copilot_cli'])('rewrites for _tg_harness=%s', (harness) => {
      const out = preBashHandler(bashEvent(`rg '^def ' ${PY_FILE}`, harness))
      expect(rewrittenCommand(out)).not.toBeNull()
    })
  })
})

describe('structural index rewrite -- unsafe path refuses to rewrite', () => {
  it('passes through a path containing a character with no shared-safe shell form', () => {
    // `$` starts variable expansion inside a double-quoted string in both a POSIX shell and
    // PowerShell -- dualShellArg refuses to quote it rather than emit a form only one of the two
    // would parse as a literal dollar sign. Has no space, so it stays one argv token unquoted in
    // the raw command line below without needing test-harness-level quoting of its own.
    const unsafeDir = path.join(TMP, 'has$dollar')
    fs.mkdirSync(unsafeDir, { recursive: true })
    const unsafeFile = path.join(unsafeDir, 'service.py').replace(/\\/g, '/')
    fs.writeFileSync(unsafeFile, PY_SRC, 'utf-8')
    indexed(unsafeFile)
    const out = preBashHandler(bashEvent(`rg '^def ' ${unsafeFile}`))
    expect(rewrittenCommand(out)).toBeNull()
  })
})

describe('structural index rewrite -- pass-through cases', () => {
  it('passes through a context flag (-C)', () => {
    const out = preBashHandler(bashEvent(`rg -C 3 '^def ' ${PY_FILE}`))
    expect(rewrittenCommand(out)).toBeNull()
  })

  it('passes through a count flag (-c)', () => {
    const out = preBashHandler(bashEvent(`rg -c '^def ' ${PY_FILE}`))
    expect(rewrittenCommand(out)).toBeNull()
  })

  it('passes through a files-only flag (-l)', () => {
    const out = preBashHandler(bashEvent(`rg -l '^def ' ${PY_FILE}`))
    expect(rewrittenCommand(out)).toBeNull()
  })

  it('passes through a piped command', () => {
    const out = preBashHandler(bashEvent(`rg '^def ' ${PY_FILE} | head -5`))
    expect(rewrittenCommand(out)).toBeNull()
  })

  it('passes through a never-indexed target', () => {
    const out = preBashHandler(bashEvent(`rg '^def ' ${NEVER_INDEXED_FILE}`))
    expect(rewrittenCommand(out)).toBeNull()
  })

  it('passes through a stale target', () => {
    const out = preBashHandler(bashEvent(`rg '^def ' ${STALE_FILE}`))
    expect(rewrittenCommand(out)).toBeNull()
  })

  it('passes through a language mismatch (^def against a .ts file)', () => {
    const out = preBashHandler(bashEvent(`rg '^def ' ${TS_FILE}`))
    expect(rewrittenCommand(out)).toBeNull()
  })

  it('passes through an unanchored bare "import" (too common a substring to trust)', () => {
    const out = preBashHandler(bashEvent(`rg 'import' ${PY_FILE}`))
    expect(rewrittenCommand(out)).toBeNull()
  })

  it('passes through a command with two file targets', () => {
    const out = preBashHandler(bashEvent(`rg '^def ' ${PY_FILE} ${TS_FILE}`))
    expect(rewrittenCommand(out)).toBeNull()
  })

  it('passes through a directory target', () => {
    const out = preBashHandler(bashEvent(`rg '^def ' ${TMP}`))
    expect(rewrittenCommand(out)).toBeNull()
  })
})

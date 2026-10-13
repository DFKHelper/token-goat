/** The Did-you-mean list on a missing-file failure (src/could_not_read.ts) and the commands that print it. Every expectation is HAND-DERIVED: the project tree is written below, and the expected suggestion is the path written there. The first line of each failure is the wording the commands printed before the list existed. The retryCommand expectations are HAND-DERIVED from the quoting rules in src/hint_suggestion_guard.ts (double quotes unless the value holds a dollar sign, backtick or double quote). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveNoteAnchor } from '../src/cli_file_ops.js'
import { run } from '../src/cli.js'
import { setCliInvocation } from '../src/command_error.js'
import { couldNotReadError, fileNotFoundError, nearPathLines, retryCommand } from '../src/could_not_read.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { noSymbolsMessage } from '../src/read_meta.js'
import { runSection } from '../src/read_section.js'

let project: string
let previousCwd: string

beforeAll(() => {
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-could-not-read-')))
  writeFileSync(join(project, 'package.json'), '{"name":"cnr"}\n')
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(join(project, 'docs'), { recursive: true })
  mkdirSync(join(project, 'config_dir'), { recursive: true })
  writeFileSync(join(project, 'config_dis'), 'x\n')
  const file = join(project, 'src', 'mod.ts')
  writeFileSync(file, 'export function alpha(): number {\n  return 1\n}\n', 'utf8')
  indexFileSync(normalizePath(file))
  writeFileSync(join(project, 'docs', 'guide.md'), '# Guide\n\n## Setup\n\nbody\n', 'utf8')
  previousCwd = process.cwd()
  process.chdir(project)
})

afterAll(() => {
  process.chdir(previousCwd)
  rmSync(project, { recursive: true, force: true })
})

describe('couldNotReadError', () => {
  it('keeps the first line and lists the file a typo meant', () => {
    expect(couldNotReadError('src/modd.ts').lines).toEqual(['Could not read: "src/modd.ts"', 'Did you mean:', '  - "src/mod.ts"'])
  })

  it('finds an indexed file by its bare name', () => {
    expect(couldNotReadError('mod.ts').lines).toEqual(['Could not read: "mod.ts"', 'Did you mean:', '  - "src/mod.ts"'])
  })

  it('adds nothing when no existing path is close', () => {
    expect(couldNotReadError('zzqq_nothing_like_it.rs').lines).toEqual(['Could not read: "zzqq_nothing_like_it.rs"'])
  })

  it('adds nothing for a path that exists but could not be read, such as a directory', () => {
    expect(couldNotReadError('src').lines).toEqual(['Could not read: "src"'])
  })

  it('adds nothing for a directory even with a near-named file beside it', () => {
    expect(couldNotReadError('config_dir').lines).toEqual(['Could not read: "config_dir"'])
  })
})

describe('fileNotFoundError and nearPathLines', () => {
  it('word the failure File not found and list the same candidates', () => {
    expect(fileNotFoundError('src/modd.ts').lines).toEqual(['File not found: "src/modd.ts"', 'Did you mean:', '  - "src/mod.ts"'])
    expect(nearPathLines('src/modd.ts')).toEqual(['Did you mean:', '  - "src/mod.ts"'])
  })
})

describe('the commands that print it', () => {
  it('section: a mistyped file gets the list after File not found', () => {
    const r = runSection({ spec: 'docs/guid.md::Setup', json: false, projectRoot: project })
    expect(r.code).toBe(1)
    expect(r.text.split('\n').slice(1)).toEqual(['Did you mean:', '  - "docs/guide.md"'])
    expect(r.text.split('\n')[0]).toMatch(/^File not found: .*guid\.md/)
  })

  it('a symbol lookup in a missing file gets the list after Could not read', () => {
    expect(noSymbolsMessage('src/modd.ts', join(project, 'src', 'modd.ts'))).toBe('Could not read: "src/modd.ts"\nDid you mean:\n  - "src/mod.ts"')
  })

  it('note --anchor: a mistyped file is refused with the list', () => {
    expect.assertions(1)
    try {
      resolveNoteAnchor('src/modd.ts::alpha', project, project)
    } catch (err) {
      expect((err as Error).message.split('\n').slice(1)).toEqual(['Did you mean:', '  - "src/mod.ts"'])
    }
  })
})

describe('retryCommand', () => {
  it('repeats the command that was run with the typed path swapped', () => {
    expect(retryCommand('src/modd.ts', 'src/mod.ts', ['outline', 'src/modd.ts'])).toBe('token-goat outline "src/mod.ts"')
  })

  it('keeps a selector after the path and the other arguments as they were', () => {
    expect(retryCommand('src/modd.ts', 'src/mod.ts', ['read', 'src/modd.ts::alpha', '--json'])).toBe('token-goat read "src/mod.ts::alpha" --json')
  })

  it('quotes a candidate holding a space and an argument that needs it', () => {
    expect(retryCommand('a.ts', 'my dir/a.ts', ['json-query', 'a.ts', 'x y'])).toBe('token-goat json-query "my dir/a.ts" "x y"')
  })

  it('gives up when the typed path is not among the arguments or no quote mark holds one', () => {
    expect(retryCommand('src/modd.ts', 'src/mod.ts', ['outline', 'other.ts'])).toBeNull()
    expect(retryCommand('src/modd.ts', 'src/mod.ts', ['outline', 'src/modd.ts', "it's $x"])).toBeNull()
  })

  it('gives up on a candidate carrying a control character', () => {
    expect(retryCommand('a.ts', 'b\u001b[31m.ts', ['outline', 'a.ts'])).toBeNull()
  })

  it('is what the failure lists when the process was started with those arguments', () => {
    const saved = process.argv
    process.argv = ['node', 'token-goat', 'outline', 'src/modd.ts']
    try {
      expect(nearPathLines('src/modd.ts')).toEqual(['Did you mean:', '  - token-goat outline "src/mod.ts"'])
    } finally {
      process.argv = saved
    }
  })

  it('reads the arguments run() recorded, not the process arguments of a hook server answering the call', () => {
    const saved = process.argv
    process.argv = ['node', 'token-goat', 'hook-server', 'run', '--slot', '0']
    setCliInvocation(['node', 'token-goat', 'outline', 'src/modd.ts'])
    try {
      expect(nearPathLines('src/modd.ts')).toEqual(['Did you mean:', '  - token-goat outline "src/mod.ts"'])
    } finally {
      process.argv = saved
      setCliInvocation(saved)
    }
  })

  it('run() records the arguments it is handed, so a call answered inside another process still lists a command', async () => {
    const saved = process.argv
    const written: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.argv = ['node', 'token-goat', 'hook-server', 'run', '--slot', '0']
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      await run(['node', 'token-goat', 'outline', 'src/modd.ts'])
    } finally {
      process.stderr.write = realWrite
      process.argv = saved
      setCliInvocation(saved)
      process.exitCode = undefined
    }
    expect(written.join('')).toContain('  - token-goat outline "src/mod.ts"')
  })
})

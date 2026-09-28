// `token-goat section <path> --list`, `image-meta` and `image-text` checked the path they were handed with a private `fileExists` that answered true for anything stat could see, a directory included, while the copies of the same helper in read_spec.ts and dep_docs.ts answered true only for a regular file. So a directory named where a document belongs got past the check: `section --list` then reported "No sections found", a claim about a document it never read, and the image commands surfaced the raw EISDIR of the read that followed. The read commands now share one regular-file check, and a path that is not a regular file reads as unreadable, as a missing path already does. The checks that mean "anything at this path" keep that meaning: grep's search path, which may be a directory, and the PDF commands, whose bounded reader refuses a non-regular file by name.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let dir: string
let stdout: string[]
let stderr: string[]
let spies: WriteSpy[]

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dir-as-document-')))
  stdout = []
  stderr = []
  spies = [spyOnWrite(process.stdout, stdout), spyOnWrite(process.stderr, stderr)]
})

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Drives the real CLI entry, so the command wiring and its error reporting are the shipping ones. */
async function runCli(argv: string[]): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

/** A directory where the command expects a document, carrying the extension that routes it to that command. */
function directoryNamed(name: string): string {
  const p = path.join(dir, name)
  fs.mkdirSync(p)
  return p
}

describe('a directory named as a document reads as unreadable', () => {
  // CAPTURE: the built bundle before this change, run under isolated homes in a scratch project where notes.md is a directory, printed "No sections found in 'notes.md'" for `section notes.md --list` and exited 1.
  it('section --list', async () => {
    const p = directoryNamed('notes.md')

    const code = await runCli(['section', p, '--list'])

    expect(code).toBe(1)
    expect(stderr.join('')).toContain(`Could not read: ${p}`)
    expect(stderr.join('')).not.toContain('No sections found')
  })

  // CAPTURE: the same run printed "token-goat: EISDIR: illegal operation on a directory, read" for `image-meta shot.png` and for `image-text shot.png`, shot.png a directory, and exited 1.
  for (const cmd of ['image-meta', 'image-text'] as const) {
    it(cmd, async () => {
      const p = directoryNamed('shot.png')

      const code = await runCli([cmd, p])

      expect(code).toBe(1)
      expect(stderr.join('')).toContain(`Could not read: ${p}`)
      expect(stderr.join('')).not.toContain('EISDIR')
    })
  }
})

describe('the checks that mean anything at the path keep that meaning', () => {
  // CAPTURE: the same run printed "token-goat: doc.pdf is not a regular file, so its size cannot be checked before reading it." for `pdf-outline doc.pdf`, doc.pdf a directory: the bounded reader's own refusal, which says more than "Could not read" and must stay the one a user sees.
  it('pdf-outline still gets the bounded reader\'s refusal of a non-regular file', async () => {
    const p = directoryNamed('doc.pdf')

    const code = await runCli(['pdf-outline', p])

    expect(code).toBe(1)
    expect(stderr.join('')).toContain('is not a regular file, so its size cannot be checked before reading it')
  })

  // HAND-DERIVED: grep takes a directory as a search path and walks it.
  it('grep still searches a directory', async () => {
    const sub = directoryNamed('src')
    fs.writeFileSync(path.join(sub, 'a.ts'), 'export const needleValue = 1\n')

    const code = await runCli(['grep', 'needleValue', sub])

    expect(code).toBe(0)
    expect(stdout.join('')).toContain('needleValue')
  })

  // HAND-DERIVED: a regular file with one heading, the case the shared check exists to let through.
  it('section --list still lists a regular file', async () => {
    const p = path.join(dir, 'doc.md')
    fs.writeFileSync(p, '## Only Heading\nbody\n')

    const code = await runCli(['section', p, '--list'])

    expect(code).toBe(0)
    expect(stdout.join('')).toContain('Only Heading')
  })
})

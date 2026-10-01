// scripts/parser-fingerprint.mjs has two modes, `--check` and no flag at all, and it chose between them by asking only whether `--check` was present, so every other argument fell through to the no-flag branch: a mistyped `--chek`, or `--help` from someone asking what the script does, silently regenerated src/parser_fingerprint.ts and src/embed_fingerprint.ts instead of checking or explaining. Regenerating from a working tree whose extraction sources moved is how a fingerprint change, and the re-index every user pays for it, gets committed by accident. Provenance: CAPTURE, every run below is the real script over a real copy of this repository's src/ tree, and the written files are compared with the ones checked in here, so the no-flag and `--check` modes are pinned to what they computed before this change. The argument contract itself (an unknown flag is a usage error with a nonzero exit and nothing written, `--help` prints the usage and exits 0) is HAND-DERIVED from the usual command-line convention, not read off the script.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EMBED_FINGERPRINT } from '../src/embed_fingerprint.js'
import { PARSER_FINGERPRINT } from '../src/parser_fingerprint.js'

const ROOT = path.join(__dirname, '..')
const OUTPUTS = ['parser_fingerprint.ts', 'embed_fingerprint.ts'] as const
const SENTINEL = '// sentinel: this file must not be rewritten\n'

let dir: string

/** The script resolves every path from its own location, so a copy of it beside a copy of src/ reads and writes the copy, never this working tree. */
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pf-args-'))
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.copyFileSync(path.join(ROOT, 'scripts', 'parser-fingerprint.mjs'), path.join(dir, 'scripts', 'parser-fingerprint.mjs'))
  for (const name of OUTPUTS) fs.writeFileSync(path.join(dir, 'src', name), SENTINEL)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [path.join(dir, 'scripts', 'parser-fingerprint.mjs'), ...args], { cwd: dir, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

function outputs(): string[] {
  return OUTPUTS.map((name) => fs.readFileSync(path.join(dir, 'src', name), 'utf8').split('\r\n').join('\n'))
}

// One sequence rather than independent cases: the first two runs must leave the sentinels in place, which is what the no-flag run then overwrites.
describe('parser-fingerprint.mjs arguments', () => {
  it('refuses an unknown flag and explains --help without writing, and still writes and checks as before', () => {
    const typo = run('--chek')
    expect(typo.status, typo.stdout + typo.stderr).toBe(2)
    expect(typo.stderr).toContain('usage: node scripts/parser-fingerprint.mjs')
    expect(typo.stderr).toContain('--chek')
    expect(outputs()).toEqual([SENTINEL, SENTINEL])

    const help = run('--help')
    expect(help.status, help.stdout + help.stderr).toBe(0)
    expect(help.stdout).toContain('usage: node scripts/parser-fingerprint.mjs')
    expect(help.stdout).toContain('--check')
    expect(outputs()).toEqual([SENTINEL, SENTINEL])

    const stale = run('--check')
    expect(stale.status, 'a sentinel is not the generated file, so --check must call it stale').toBe(1)

    const write = run()
    expect(write.status, write.stdout + write.stderr).toBe(0)
    const checkedIn = OUTPUTS.map((name) => fs.readFileSync(path.join(ROOT, 'src', name), 'utf8').split('\r\n').join('\n'))
    expect(outputs()).toEqual(checkedIn)

    const check = run('--check')
    expect(check.status, check.stdout + check.stderr).toBe(0)
    expect(check.stdout).toContain(`parser fingerprint up to date (${PARSER_FINGERPRINT})`)
    expect(check.stdout).toContain(`embed fingerprint up to date (${EMBED_FINGERPRINT})`)
  })

  // CAPTURE: CI's test-macos job on 57c9fbb3, where os.tmpdir() is under /var, a link to /private/var, and the case above got exit 0 for `--chek` because the script took itself for imported. A directory link reproduces that on every platform: a junction on Windows, which needs no symlink privilege, and a symlink elsewhere.
  it('acts when run through a linked directory', () => {
    const link = `${dir}-link`
    fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const res = spawnSync(process.execPath, [path.join(link, 'scripts', 'parser-fingerprint.mjs'), '--chek'], { cwd: link, encoding: 'utf8' })
      expect(res.status, res.stdout + res.stderr).toBe(2)
      expect(res.stderr).toContain('--chek')
      const check = spawnSync(process.execPath, [path.join(link, 'scripts', 'parser-fingerprint.mjs'), '--check'], { cwd: link, encoding: 'utf8' })
      expect(check.stdout).toContain(`parser fingerprint up to date (${PARSER_FINGERPRINT})`)
    } finally {
      // Removes the link, never what it points at: a junction is a directory entry to Windows, a symlink a file entry elsewhere.
      if (process.platform === 'win32') fs.rmdirSync(link)
      else fs.unlinkSync(link)
    }
  })
})

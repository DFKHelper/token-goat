/**
 * Regression: a caller-supplied git ref lands in argv where git expects a revision, but git still
 * reads a leading `-` as an option. `--output=<path>` turns `git diff` and `git log` into an
 * arbitrary-file-write primitive: the ref `--output=victim.txt` truncated a real 20-byte file to
 * 0 bytes, and `--output=<outside-the-project>` wrote 1754 bytes of real commit history outside
 * the project root -- both at exit 0, with the command reporting success.
 *
 * `runChanged` already refused such a ref, but nothing anywhere tested that guard (`rg "Refusing a
 * git ref" tests/` had no hits), and `diff` and `log` were each written without it. The guard is
 * now one shared pair of helpers called by all three, and it runs as the FIRST statement in `diff`
 * and `log` -- before the symbol is resolved -- so a hostile ref is refused even when the symbol
 * does not exist, rather than being reached only on the happy path.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runChanged, runDiff, runLog } from '../src/read_commands.js'

function capture(fn: () => number): { stdout: string; stderr: string; code: number } {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = (s: string) => { stdout += s; return true }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = (s: string) => { stderr += s; return true }
  let code: number
  try {
    code = fn()
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = origOut
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = origErr
  }
  return { stdout, stderr, code }
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop()
    if (r !== undefined) rmSync(r, { recursive: true, force: true })
  }
})

/** A real repo with one indexed symbol and one innocent file for git to overwrite. */
function makeRepo(): { root: string; victim: string } {
  const root = mkdtempSync(join(tmpdir(), 'tg-refguard-'))
  roots.push(root)
  git(['init'], root)
  git(['config', 'user.email', 'test@example.com'], root)
  git(['config', 'user.name', 'Test'], root)
  const file = join(root, 'a.ts')
  writeFileSync(file, 'export function target(): number {\n  return 1\n}\n')
  const victim = join(root, 'victim.txt')
  writeFileSync(victim, 'PRECIOUS-CONTENT-KEEP\n')
  git(['add', '-A'], root)
  git(['commit', '-m', 'first'], root)
  writeFileSync(file, 'export function target(): number {\n  return 2\n}\n')
  git(['commit', '-am', 'second'], root)
  indexFileSync(normalizePath(file))
  return { root, victim }
}

const HOSTILE = '--output=victim.txt'

describe('git ref guard: a ref starting with "-" is refused, not handed to git', () => {
  it.each([
    ['diff', (root: string) => runDiff({ spec: 'a.ts::target', projectRoot: root, ref: HOSTILE })],
    ['log', (root: string) => runLog({ spec: 'a.ts::target', projectRoot: root, ref: HOSTILE })],
    ['changed', (root: string) => runChanged({ projectRoot: root, ref: HOSTILE })],
  ])('%s refuses --output= and leaves the target file untouched', (name, run) => {
    const { root, victim } = makeRepo()
    const before = readFileSync(victim, 'utf8')

    const { stderr, code } = capture(() => run(root))

    expect(code, `${name} did not fail on a hostile ref`).toBe(1)
    expect(stderr).toContain("Refusing a git ref that starts with '-'")
    expect(stderr).toContain(HOSTILE)
    expect(
      readFileSync(victim, 'utf8'),
      `${name} let git's --output= truncate or overwrite an unrelated file`,
    ).toBe(before)
    expect(statSync(victim).size).toBeGreaterThan(0)
  })

  // The guard has to run before the symbol lookup: a hostile ref with a symbol that does not
  // resolve must still be refused as a hostile ref, not merely fail later for another reason.
  it.each([
    ['diff', (root: string) => runDiff({ spec: 'a.ts::nosuchsymbol', projectRoot: root, ref: HOSTILE })],
    ['log', (root: string) => runLog({ spec: 'a.ts::nosuchsymbol', projectRoot: root, ref: HOSTILE })],
  ])('%s refuses the ref before resolving the symbol', (name, run) => {
    const { root, victim } = makeRepo()

    const { stderr, code } = capture(() => run(root))

    expect(code).toBe(1)
    expect(stderr, `${name} reached symbol resolution with a hostile ref still in hand`).toContain(
      "Refusing a git ref that starts with '-'",
    )
    expect(readFileSync(victim, 'utf8')).toBe('PRECIOUS-CONTENT-KEEP\n')
  })

  it('still accepts an ordinary ref', () => {
    const { root } = makeRepo()
    const { code } = capture(() => runDiff({ spec: 'a.ts::target', projectRoot: root, ref: 'HEAD~1' }))
    expect(code).toBe(0)
  })

  // A bare `-` is not an option to git, but it is also not a revision, and allowing it would mean
  // the guard tested only the prefix of a longer string.
  it('refuses a bare dash', () => {
    const { root } = makeRepo()
    const { stderr, code } = capture(() => runLog({ spec: 'a.ts::target', projectRoot: root, ref: '-' }))
    expect(code).toBe(1)
    expect(stderr).toContain("Refusing a git ref that starts with '-'")
  })
})

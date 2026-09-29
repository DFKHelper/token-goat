import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

/**
 * A test may delete a path it built from `os.homedir()` only through tests/helpers/sandbox-rm.ts. A raw
 * `rmSync(path.join(os.homedir(), '.claude'), { recursive: true })` is safe only while
 * tests/setup/isolate-home.ts has redirected HOME/USERPROFILE, and nothing at the call site says so: the
 * same line run without that setup deletes the developer's real Claude Code home. On 2026-09-28 the
 * maintainer's real `~/.claude` (hooks, credentials, transcripts) disappeared during a full-suite run; the
 * cause was never reproduced, and four test files held exactly this shape. The helper refuses any target
 * outside the run root, so the delete fails loudly instead.
 *
 * Static scan: an identifier assigned from an expression mentioning `homedir()` is tracked, transitively
 * through further assignments that mention a tracked identifier, and any delete call whose argument
 * mentions `homedir()` or a tracked identifier is a violation. Per file, textual -- it can miss a path that
 * crosses a function boundary, which is why the helper also asserts at run time.
 */

const TESTS_DIR = path.resolve(__dirname, '..')
const HELPER = path.join(TESTS_DIR, 'helpers', 'sandbox-rm.ts')
const DELETE_CALL = /\b(?:rmSync|rmdirSync|rm|rmdir|unlinkSync|unlink)\(([^;\n]*)/g

function collect(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // tests/.tg-* are other tests' gitignored scratch dirs, made and removed while this walk runs; none holds a committed file.
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'fixtures' && e.name !== 'node_modules') out.push(...collect(p))
    } else if (/\.(?:ts|mts|mjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

function homedirDeletes(source: string): string[] {
  const assigns = [...source.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*([^;\n]*)/g)].map((m) => ({ id: m[1]!, rhs: m[2]! }))
  const tracked = new Set<string>()
  const mentions = (text: string): boolean => /homedir\(\)/.test(text) || [...tracked].some((id) => new RegExp(`\\b${id}\\b`).test(text))
  for (let grew = true; grew; ) {
    grew = false
    for (const a of assigns) {
      if (!tracked.has(a.id) && mentions(a.rhs)) {
        tracked.add(a.id)
        grew = true
      }
    }
  }
  return [...source.matchAll(DELETE_CALL)].filter((m) => mentions(m[1]!)).map((m) => m[0].trim())
}

describe('homedir-derived deletes in tests go through rmInSandbox', () => {
  it('no test file deletes a path built from os.homedir() directly', () => {
    const offenders: string[] = []
    // The anchor is the file that held the unsandboxed ~/.claude delete this guard was written for: if the walk stops reaching it, it is not scanning the files at issue.
    for (const file of pinnedPopulation({ what: 'tests/**/*.{ts,mts,mjs,js} files scanned for homedir deletes', items: collect(TESTS_DIR), floor: 600, mustInclude: ['hooks_agent_spawn_copilot.test.ts'] })) {
      if (file === HELPER || file === __filename) continue
      for (const hit of homedirDeletes(fs.readFileSync(file, 'utf8'))) offenders.push(`${path.relative(TESTS_DIR, file)}: ${hit}`)
    }
    expect(offenders, 'use rmInSandbox from tests/helpers/sandbox-rm.ts').toEqual([])
  })

  // HAND-DERIVED: each source below is written to exercise one detection path; the first is the exact line tests/hooks_agent_spawn_copilot.test.ts:68 held before this guard.
  it.each([
    ["fs.rmSync(path.join(os.homedir(), '.claude'), { recursive: true, force: true })"],
    ["const home = os.homedir()\nfs.rmSync(path.join(home, '.claude'), { recursive: true })"],
    ["const home = os.homedir()\nconst dir = path.join(home, '.claude')\nawait fs.promises.rm(dir, { recursive: true })"],
  ])('flags %j', (source) => {
    expect(homedirDeletes(source)).toHaveLength(1)
  })

  it.each([
    ["rmInSandbox(path.join(os.homedir(), '.claude'))"],
    ["const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))\nfs.rmSync(tmp, { recursive: true, force: true })"],
  ])('passes %j', (source) => {
    expect(homedirDeletes(source)).toEqual([])
  })
})

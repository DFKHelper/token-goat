/**
 * Structural guard on the hook-install command-line boundary: a function that builds the shell
 * command line an external harness (Claude Code, Grok, Kimi, Gemini CLI, Qwen Code) writes into
 * its own config and later parses through its own shell must wrap every embedded path through the
 * shared escaping helper rather than interpolating it into a bare double-quoted segment. A double
 * quote is a legal character in a macOS or Linux filename, so an unescaped one can break out of
 * the quoted argument once the downstream harness's shell parses the generated line; Windows
 * filenames cannot contain that character at all, so the same interpolation is harmless there.
 * The real defect this guard exists for: enterprise security loop 10 found the escaping missing
 * on util.ts's `hookCommandFor`, and the exact same unescaped shape independently duplicated in
 * two sibling bridges (`geminiHookCommand`, `qwenHookCommand`) that build the same kind of command
 * line without routing through that function at all.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { calleeNames, functionMap, parseTopLevelFunctions, type FnInfo } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** Self-exclusion token so this guard's own source never satisfies a scan of itself. Never appears in real code: /NOSUCH[X]TOKEN/. */
const SELF_EXCLUDE_MARKER = 'NOSUCH[X]TOKEN'
void SELF_EXCLUDE_MARKER

/** The shared escaping helper every site below must reach before embedding a path in the generated command line. */
const ESCAPE_TERMINAL = 'quoteShellPath('

interface Site {
  readonly file: string
  readonly fn: string
}

/** Every function this session's sweep confirmed builds a hook-install command line by embedding process.execPath and a script or entry path in a double-quoted shell argument. */
const QUOTING_SITES: readonly Site[] = [
  { file: 'util.ts', fn: 'hookCommandFor' },
  { file: 'bridges/gemini_install.ts', fn: 'geminiHookCommand' },
  { file: 'bridges/qwen_install.ts', fn: 'qwenHookCommand' },
]

/** True when `fileName::fnName` still exists as a top-level function in src. */
function siteExists(site: Site): boolean {
  const full = path.join(SRC_DIR, site.file)
  if (!fs.existsSync(full)) return false
  const fns = parseTopLevelFunctions(fs.readFileSync(full, 'utf8'))
  return fns.some((f) => f.name === site.fn)
}

// Deliberately not the shared `reaches()` helper from reachability.ts: that one runs every body
// through `codeOnly()` before testing the predicate, which blanks template literals -- and every
// site here calls quoteShellPath from inside a template-literal interpolation, so codeOnly would
// erase the very call this guard exists to find and the guard would pass with an empty population
// of evidence rather than a real one. This walks the raw, unstripped body text instead.
function reachesRaw(fn: FnInfo, byName: Map<string, string>, predicate: (body: string) => boolean): boolean {
  const visited = new Set<string>()
  const stack: string[] = [fn.name]
  while (stack.length > 0) {
    const name = stack.pop()!
    if (visited.has(name)) continue
    visited.add(name)
    const body = byName.get(name)
    if (body === undefined) continue
    if (predicate(body)) return true
    for (const callee of calleeNames(body)) {
      if (!visited.has(callee) && byName.has(callee)) stack.push(callee)
    }
  }
  return false
}

describe('every function that embeds a path in a generated hook command line reaches quoteShellPath', () => {
  it('finds a real, present population rather than passing on an empty or stale list', () => {
    const present = QUOTING_SITES.filter(siteExists).map((s) => `${s.file}::${s.fn}`)
    pinnedPopulation({
      what: 'functions known to build a hook-install command line by embedding process.execPath and a script or entry path in a double-quoted shell argument',
      items: present,
      floor: 2,
      mustInclude: ['util.ts::hookCommandFor'],
    })

    // Symmetric stale-key check: every named site must still exist, so an exemption (or, here, a
    // pinned site) can't silently outlive the function it names.
    const stale = QUOTING_SITES.filter((s) => !siteExists(s)).map((s) => `${s.file}::${s.fn}`)
    expect(stale, `QUOTING_SITES names a function that no longer exists:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  it('reaches quoteShellPath before embedding a path in the command line, per site', () => {
    const unescaped: string[] = []
    for (const site of QUOTING_SITES) {
      const full = path.join(SRC_DIR, site.file)
      const src = fs.readFileSync(full, 'utf8')
      const fns = parseTopLevelFunctions(src)
      const byName = functionMap(fns)
      const fn = fns.find((f) => f.name === site.fn)
      if (fn === undefined) continue // reported as stale by the sibling test above
      const escaped = reachesRaw(fn, byName, (body) => body.includes(ESCAPE_TERMINAL))
      if (!escaped) unescaped.push(`${site.file}::${site.fn}`)
    }
    expect(
      unescaped,
      'These functions embed a path in a generated hook command line but never reach quoteShellPath(...). ' +
        'An install-time path containing a double quote (legal on macOS/Linux) can break out of the quoted ' +
        'argument once the downstream harness\'s shell parses the generated line. Route every embedded path ' +
        'through quoteShellPath before interpolating it.\n  ' +
        unescaped.join('\n  '),
    ).toEqual([])
  })
})

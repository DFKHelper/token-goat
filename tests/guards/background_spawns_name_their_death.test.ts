/** Guard against the unowned-background-process class. A child started `detached: true`, or let go with `.unref()`, outlives the process that started it; the audit that produced this guard found 29 `find /` walks left behind by timed-out agent shells, each running for hours. So every such site in src/ must say, in a single-line comment on the line itself or the line above, who owns the process and what ends it: `// owner: <who> ... dies when <condition>`. A site with no real death condition cannot honestly carry that comment, which is the point: it is reported, not papered over. A child that is neither detached nor unref'd is held to the same rule unless it is started through spawnOwned (src/process_tree.ts), because it is the case that left the OCR helper running for ever once its parent was killed. Limits: it checks that the comment has the shape, not that what it claims is true (a false comment passes), it reads the .ts files under src/ only so the Rust shims under native/ are not scanned, and a child bound to a name another way (destructuring, a returned handle) is only seen when it is released in the same expression as its spawn. Provenance: HAND-DERIVED. The sample sources below are written for this file from the rule, not from the scanner's own regexes; the real-tree test reads src/ as shipped. */

// tg-no-regex-preload
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

const OWNER_COMMENT = /\/\/\s*owner:.*\bdies when\b/

/** The code half of a line: a trailing `//` comment and a whole-line comment are cut off, so prose that mentions `detached` or `.unref()` never matches. */
function codeOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  const at = line.search(/\s\/\/\s/)
  return at === -1 ? line : line.slice(0, at)
}

/** Names this file binds to a child process: assigned from a spawning call, or declared with the ChildProcess type. A timer's `.unref()` is a different thing (it only stops the timer holding the loop open) and is not matched. */
function childNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const line of lines) {
    const code = codeOf(line)
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?::\s*ChildProcess[\w<>]*\s*)?=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)?(?:spawn|fork|execFile)\(/g)) names.add(m[1]!)
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*ChildProcess\b/g)) names.add(m[1]!)
  }
  return names
}

/** One entry per site that starts a detached child or releases a child with `.unref()` and has no owner comment: `file:line: text`. */
function unownedSites(file: string, source: string): string[] {
  const lines = source.split(/\r?\n/)
  const children = childNames(lines)
  const found: string[] = []
  lines.forEach((line, i) => {
    const code = codeOf(line)
    let site = /(?:^|[\s{,(])detached\s*:/.test(code) || /\b(?:spawn|fork|execFile)\(.*\)\s*\.unref\(\)/.test(code)
    if (!site) {
      for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\.unref\(\)/g)) {
        if (children.has(m[1]!)) site = true
      }
    }
    if (!site) return
    const above = i > 0 ? lines[i - 1]!.trim() : ''
    if (OWNER_COMMENT.test(line) || (above.startsWith('//') && OWNER_COMMENT.test(above))) return
    found.push(`${file}:${i + 1}: ${line.trim()}`)
  })
  return found
}

/** The text of the call whose opening parenthesis is at column `from` of `lines[i]`, up to its closing parenthesis (a parenthesis inside a string literal does not count), so an option in the next statement is never mistaken for one of this call's. */
function callExpression(lines: readonly string[], i: number, from: number): string {
  let depth = 0
  let quote = ''
  let text = ''
  for (let n = i; n < lines.length; n++) {
    const code = n === i ? codeOf(lines[n]!).slice(from) : codeOf(lines[n]!)
    for (let c = 0; c < code.length; c++) {
      const ch = code[c]!
      text += ch
      if (quote !== '') {
        if (ch === '\\') text += code[++c] ?? ''
        else if (ch === quote) quote = ''
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) return text
    }
    text += '\n'
    // Only a template literal runs on to the next line.
    if (quote !== '`') quote = ''
  }
  return text
}

/** One entry per bare `spawn(` or `fork(` call that is not detached (the scan above owns those) and has no owner comment: such a child dies with nobody's say-so only if its parent lives to end it, so it either goes through spawnOwned or says what ends it. */
function unownedPlainSpawns(file: string, source: string): string[] {
  if (file.endsWith('/process_tree.ts')) return []
  const lines = source.split(/\r?\n/)
  const found: string[] = []
  lines.forEach((line, i) => {
    const opened = /(?:^|[^\w$])(?:spawn|fork)\(/.exec(codeOf(line))
    if (opened === null) return
    if (/(?:^|[\s{,(])detached\s*:/.test(callExpression(lines, i, opened.index + opened[0].length - 1))) return
    const above = i > 0 ? lines[i - 1]!.trim() : ''
    if (OWNER_COMMENT.test(line) || (above.startsWith('//') && OWNER_COMMENT.test(above))) return
    found.push(`${file}:${i + 1}: ${line.trim()}`)
  })
  return found
}

/** How many sites the scan recognises in `source`, owned or not: the owner comments are removed first, so every site shows up as unowned. */
function siteCount(source: string): number {
  const stripped = source
    .split(/\r?\n/)
    .map((l) => (l.trim().startsWith('// owner:') ? '' : l.replace(/\s\/\/\s*owner:.*$/, '')))
    .join('\n')
  return unownedSites('x', stripped).length
}

function sourceFiles(): readonly string[] {
  const items = fs.readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter((rel) => rel.endsWith('.ts')).map((rel) => rel.split(path.sep).join('/'))
  return pinnedPopulation({ what: 'TypeScript files under src/', items, floor: 400, mustInclude: ['worker_lifecycle.ts', 'hook_client.ts', 'bridges/copilot_session_start.ts', 'process_tree.ts'] })
}

describe('every detached or unref\'d child names who owns it and what ends it', () => {
  it('flags a detached spawn with no owner comment', () => {
    const src = ["import { spawn } from 'node:child_process'", "const child = spawn('x', [], { detached: true })", 'child.unref()'].join('\n')
    expect(unownedSites('a.ts', src)).toEqual(['a.ts:2: const child = spawn(\'x\', [], { detached: true })', 'a.ts:3: child.unref()'])
  })

  it('accepts the comment on the line above or on the line itself', () => {
    const above = ['// owner: the shim, which kills the group; dies when the helper exits.', "const child = spawn('x', [], { detached: true })"].join('\n')
    const same = "const child = spawn('x', [], { detached: true }) // owner: none; dies when idle."
    expect(unownedSites('a.ts', above)).toEqual([])
    expect(unownedSites('a.ts', same)).toEqual([])
  })

  it('rejects a comment that names no owner or no death condition', () => {
    const noOwner = ['// keeps running in the background; dies when idle.', "const child = spawn('x', [], { detached: true })"].join('\n')
    const noDeath = ['// owner: the shim.', "const child = spawn('x', [], { detached: true })"].join('\n')
    const far = ['// owner: the shim; dies when the helper exits.', 'const a = 1', "const child = spawn('x', [], { detached: true })"].join('\n')
    expect(unownedSites('a.ts', noOwner)).toHaveLength(1)
    expect(unownedSites('a.ts', noDeath)).toHaveLength(1)
    expect(unownedSites('a.ts', far)).toHaveLength(1)
  })

  it('flags unref on a typed child parameter and on a spawned root, not on a timer or a stream', () => {
    const src = [
      'function discard(child: ChildProcess): void {',
      '  child.unref()',
      '}',
      "const root = spawn('x')",
      'root.unref()',
      'const timer = setTimeout(() => {}, 1)',
      'timer.unref()',
      'setInterval(() => {}, 1000).unref()',
      'process.stdin.unref()',
    ].join('\n')
    expect(unownedSites('a.ts', src).map((s) => s.split(': ')[0])).toEqual(['a.ts:2', 'a.ts:5'])
  })

  it('flags a module-qualified spawn and a spawn released in the same expression', () => {
    const src = ["const root = cp.spawn('x')", 'root.unref()', "spawn('y', []).unref()"].join('\n')
    expect(unownedSites('a.ts', src).map((s) => s.split(': ')[0])).toEqual(['a.ts:2', 'a.ts:3'])
  })

  it('ignores prose that merely mentions the words', () => {
    const src = ['/** The detached worker is unref\'d: `child.unref()`. */', '// a detached: true option is documented here', ' * detached: true', 'const x = 1'].join('\n')
    expect(unownedSites('a.ts', src)).toEqual([])
  })

  it('flags a plain spawn that is neither owned nor commented, and accepts spawnOwned, spawnSync and a comment', () => {
    const plain = ["const child = spawn(process.execPath, ['-e', script], { stdio: 'pipe' })"].join('\n')
    const owned = ["const owned = spawnOwned(process.execPath, ['-e', script], { stdio: 'pipe' })", "const r = spawnSync('ps', [])", "const f = cp.execFileSync('x')"].join('\n')
    const commented = ['// owner: this process, which waits for it; dies when its command finishes.', "const child = spawn('x', [], { stdio: 'inherit' })"].join('\n')
    expect(unownedPlainSpawns('src/a.ts', plain)).toHaveLength(1)
    expect(unownedPlainSpawns('src/b.ts', owned)).toEqual([])
    expect(unownedPlainSpawns('src/c.ts', commented)).toEqual([])
    expect(unownedPlainSpawns('src/process_tree.ts', plain)).toEqual([])
  })

  it('exempts a spawn only for a detached option of its own call, not one in the next statement', () => {
    const next = ["const a = spawn('x', [], { stdio: 'pipe' })", "const b = spawn('y', [], { detached: true })"].join('\n')
    const own = ["const a = spawn('x', [", "  'a (b',", '], {', '  stdio: \'pipe\',', '  detached: true,', '})'].join('\n')
    expect(unownedPlainSpawns('src/a.ts', next)).toEqual(["src/a.ts:1: const a = spawn('x', [], { stdio: 'pipe' })"])
    expect(unownedPlainSpawns('src/b.ts', own)).toEqual([])
  })

  it('finds every plain spawn in src/ owned or routed through spawnOwned', () => {
    const unowned = sourceFiles().flatMap((rel) => unownedPlainSpawns(`src/${rel}`, fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')))
    expect(unowned, 'a child started with spawn or fork that is not spawnOwned and carries no `// owner: ... dies when ...` comment on its line or the line above').toEqual([])
  })

  it('finds every site in src/ owned', () => {
    const unowned = sourceFiles().flatMap((rel) => unownedSites(`src/${rel}`, fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')))
    expect(unowned, 'a detached or unref\'d child with no `// owner: ... dies when ...` comment on its line or the line above').toEqual([])
  })

  it('is looking at the sites that exist: each launcher is seen by the scan', () => {
    // Removing the owner comments from these files must surface their sites, so a scan that stopped matching them would fail here rather than pass an empty tree.
    for (const rel of ['worker_lifecycle.ts', 'hook_client.ts', 'bridges/copilot_session_start.ts']) {
      const source = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')
      expect(siteCount(source), `${rel} has no site the scan recognises`).toBeGreaterThan(0)
    }
  })
})

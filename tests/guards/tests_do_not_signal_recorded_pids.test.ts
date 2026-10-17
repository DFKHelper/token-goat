/** Guard against a test signalling a pid it merely recorded. A pid read from a file, a heartbeat, a status listing or an earlier `alive` probe is a claim: the OS hands a freed number to the next process it starts, and on Windows process.kill(pid, 'SIGKILL') and taskkill are TerminateProcess(handle, 1), so the kill of a pid that had already exited ends whatever holds the number now. That is how a vitest worker forked a moment earlier died with "Worker exited unexpectedly with exit code 1 during started state" in a file that had nothing to do with the kill. A test signals a child through the ChildProcess handle it owns (the handle signals the process it holds and nothing once that has exited), or through killIfCommandLine in tests/helpers/kill_if_command_line.ts, which reads the command line immediately before the signal. This scan fails on any other signal (process.kill with a signal other than 0, a process-group kill, a taskkill, terminateProcessTree, killProcessTree) whose target is not the pid of a handle bound in the same file. Provenance: HAND-DERIVED; the planted sites below are written from the rule, and the allowlist is read off the tree on 2026-10-17. */

// tg-no-regex-preload
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = path.join(HERE, '..')

interface Allowed {
  /** Path under tests/, forward slashes. */
  readonly file: string
  /** A substring of the site's line. */
  readonly text: string
  /** Why the site cannot signal a reused pid. */
  readonly reason: string
}

/** Every site the scan flags and the rule does not apply to. An entry that no longer matches a site fails the guard, so the list cannot rot. */
const ALLOWED: readonly Allowed[] = [
  { file: 'helpers/kill_if_command_line.ts', text: 'process.kill(pid, opts.signal', reason: 'the implementation: it signals only after reading the command line of this very pid' },
  { file: 'helpers/kill_if_command_line.ts', text: 'terminateProcessTree(pid', reason: 'the implementation: the tree kill follows the same command-line read' },
  { file: 'setup/build-bundle.ts', text: 'terminateProcessTree(pid, true)', reason: 'killDaemonsUnder reads the command line of the heartbeat pid and checks isResidentOfInstall on the lines just above, then kills' },
  { file: 'process_tree_freeze_passes.test.ts', text: 'killProcessTree(ROOT)', reason: 'ROOT is a made-up number and spawnSync is mocked, so no real process is signalled' },
  { file: 'resident_process.test.ts', text: 'terminateProcessTree(pid, true)', reason: 'the refusal cases: pids 0, 1, -1 and this process and its parent must be refused, so nothing is signalled' },
]

/** Test files another branch owns and is converting: skipped whole, not allowlisted, so that its merge needs no edit here. Remove this once that branch has merged. */
const DEFERRED = /(?:^|\/)copilot_session_start[^/]*$/

/** This file's own planted bad sites are text, not kills. */
const SELF = 'guards/tests_do_not_signal_recorded_pids.test.ts'

const CODE_EXT = /\.(?:ts|mts|mjs|cjs|js)$/

/** The code half of a line: a whole-line comment and a trailing ` // ...` comment are cut off, so prose that mentions a kill never matches. */
function codeOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  const at = line.search(/\s\/\/\s/)
  return at === -1 ? line : line.slice(0, at)
}

/** The text between the parentheses of the call whose opening parenthesis is at `lines[i][from]`, over as many lines as it takes. */
function callText(lines: readonly string[], i: number, from: number): string {
  let depth = 0
  let quote = ''
  let text = ''
  for (let n = i; n < lines.length; n++) {
    const code = n === i ? codeOf(lines[n]!).slice(from) : codeOf(lines[n]!)
    for (let c = 0; c < code.length; c++) {
      const ch = code[c]!
      if (quote !== '') {
        text += ch
        if (ch === '\\') text += code[++c] ?? ''
        else if (ch === quote) quote = ''
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if (ch === '(') {
        depth++
        if (depth === 1) continue
      } else if (ch === ')' && --depth === 0) return text
      text += ch
    }
    text += '\n'
    if (quote !== '`') quote = ''
  }
  return text
}

/** The top-level, comma-separated arguments of a call's text. */
function splitArgs(text: string): string[] {
  const args: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (let c = 0; c < text.length; c++) {
    const ch = text[c]!
    if (quote !== '') {
      current += ch
      if (ch === '\\') current += text[++c] ?? ''
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
    } else current += ch
  }
  if (current.trim() !== '') args.push(current.trim())
  return args
}

/** Names this file binds to a child process it owns: assigned from a spawning call (spawn, fork, execFile, spawnOwned's `.child`), typed ChildProcess, or the element of a list of them. A pid read off one of these is the handle's own. */
function handleNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>(['child', 'this.child'])
  for (const line of lines) {
    const code = codeOf(line)
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?::\s*ChildProcess[\w<>]*\s*)?=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)?(?:spawn|fork|execFile|spawnOwned|startHost)\(/g)) names.add(m[1]!)
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*ChildProcess\b/g)) names.add(m[1]!)
    for (const m of code.matchAll(/\bconst\s*\{([^}]*)\}\s*=\s*(?:await\s+)?startHost\(/g)) for (const part of m[1]!.split(',')) names.add(part.split(':').pop()!.trim())
  }
  return names
}

/** The expression a pid is read from, with a cast, a non-null assertion, a sign and wrapping parentheses removed: `-(host.pid as number)` is `host.pid`. */
function bareTarget(expr: string): string {
  let e = expr.trim()
  for (;;) {
    const before = e
    e = e.replace(/^-\s*/, '').replace(/\s+as\s+[\w.]+$/, '').replace(/!$/, '').trim()
    if (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1).trim()
    if (e === before) return e
  }
}

/** True for a pid the handle itself holds (`child.pid`, `owned.child.pid`) or this process's own. */
function isHandlePid(target: string, handles: ReadonlySet<string>): boolean {
  if (target === 'process.pid') return true
  const m = /^([A-Za-z_$][\w$.]*)\.pid$/.exec(target)
  if (m === null) return false
  const owner = m[1]!
  return handles.has(owner) || owner.endsWith('.child') || handles.has(owner.split('.').pop()!)
}

/** The pid expression of a `${...}` or `String(...)` inside a taskkill argument list, or the whole argument when it is a bare identifier or member. */
function taskkillTargets(args: string): string[] {
  const out: string[] = []
  for (const m of args.matchAll(/String\(([^()]*)\)/g)) out.push(bareTarget(m[1]!))
  for (const m of args.matchAll(/\$\{([^}]*)\}/g)) out.push(bareTarget(m[1]!))
  return out
}

/** One entry per site in `source` that signals a pid which is not a handle's own: `file:line: text`. */
function flaggedSites(file: string, source: string): string[] {
  const lines = source.split(/\r?\n/)
  const handles = handleNames(lines)
  const found: string[] = []
  const flag = (i: number): void => void found.push(`${file}:${i + 1}: ${lines[i]!.trim()}`)
  lines.forEach((line, i) => {
    const code = codeOf(line)
    for (const m of code.matchAll(/(?:^|[^\w$.])process\.kill\(/g)) {
      const args = splitArgs(callText(lines, i, m.index + m[0].length - 1))
      const signal = args[1]
      if (signal === '0') continue
      if (!isHandlePid(bareTarget(args[0] ?? ''), handles)) flag(i)
    }
    for (const m of code.matchAll(/(?:^|[^\w$.])(?:terminateProcessTree|killProcessTree)\(/g)) {
      const args = splitArgs(callText(lines, i, m.index + m[0].length - 1))
      if (!isHandlePid(bareTarget(args[0] ?? ''), handles)) flag(i)
    }
    for (const m of code.matchAll(/['"`]taskkill(?:\.exe)?['"`]/g)) {
      // The argument list is the call's own (`spawnSync('taskkill', [...])`), read from the quote on.
      const open = code.lastIndexOf('(', m.index)
      if (open === -1) continue
      const args = callText(lines, i, open)
      const targets = taskkillTargets(args)
      if (targets.length === 0 || targets.some((t) => !isHandlePid(t, handles))) flag(i)
    }
  })
  return [...new Set(found)]
}

function walk(dir: string, rel: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'fixtures' || entry.name === 'node_modules') continue
      walk(path.join(dir, entry.name), childRel, out)
    } else if (CODE_EXT.test(entry.name)) out.push(childRel)
  }
}

function testFiles(): readonly string[] {
  const items: string[] = []
  walk(TESTS_DIR, '', items)
  return pinnedPopulation({ what: 'script files under tests/', items, floor: 500, mustInclude: ['worker_retire.test.ts', 'hook_server.test.ts', 'setup/build-bundle.ts', 'helpers/kill_if_command_line.ts'] })
}

describe('the scan', () => {
  it('flags a kill of a recorded pid, in each spelling', () => {
    const bad = [
      "const pid = Number(fs.readFileSync(f, 'utf8'))",
      "process.kill(pid, 'SIGKILL')",
      'process.kill(pid)',
      "process.kill(-pgid, 'SIGKILL')",
      "if (alive(pid)) process.kill(c.pid, 'SIGTERM')",
      "spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)])",
      'killProcessTree(pid)',
      'terminateProcessTree(recorded, true)',
      "process.kill(Number(text), 'SIGKILL')",
    ].join('\n')
    expect(flaggedSites('a.ts', bad).map((s) => s.split(':')[1])).toEqual(['2', '3', '4', '5', '6', '7', '8', '9'])
  })

  it('accepts a probe, a handle, this process, a comment and killIfCommandLine', () => {
    const good = [
      "const child = spawn(process.execPath, ['-e', '0'])",
      'process.kill(pid, 0)',
      "process.kill(child.pid as number, 'SIGKILL')",
      "process.kill(-(child.pid as number), 'SIGKILL')",
      "process.kill(process.pid, 'SIGTERM')",
      "// process.kill(pid, 'SIGKILL') in prose",
      "killIfCommandLine(pid, isWorkerDaemonCommandLine, { signal: 'SIGTERM' })",
      "spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)])",
      "const owned = spawnOwned('sh', [])",
      'killProcessTree(owned.child.pid)',
    ].join('\n')
    expect(flaggedSites('a.ts', good)).toEqual([])
  })

  it('reads a call that runs over several lines', () => {
    const bad = ['process.kill(', '  recorded,', "  'SIGKILL',", ')'].join('\n')
    expect(flaggedSites('a.ts', bad)).toEqual(['a.ts:1: process.kill('])
  })
})

describe('no test signals a pid it only recorded', () => {
  it('finds every signalling site on a handle, a probe, or the allowlist', () => {
    const files = testFiles().filter((rel) => !DEFERRED.test(rel) && rel !== SELF)
    const sites = files.flatMap((rel) => flaggedSites(rel, fs.readFileSync(path.join(TESTS_DIR, rel), 'utf8')))
    const unexplained = sites.filter((site) => {
      const [head, ...rest] = site.split(': ')
      const rel = head!.split(':')[0]!
      const text = rest.join(': ')
      return !ALLOWED.some((a) => a.file === rel && text.includes(a.text))
    })
    expect(unexplained, 'a test signals a pid read from a file, a listing or an earlier probe: use killIfCommandLine (tests/helpers/kill_if_command_line.ts) or kill() on the ChildProcess the test owns').toEqual([])
  })

  it('has no allowlist entry without a site, and a reason on each', () => {
    const files = testFiles().filter((rel) => rel !== SELF)
    const sites = files.flatMap((rel) => flaggedSites(rel, fs.readFileSync(path.join(TESTS_DIR, rel), 'utf8')))
    for (const a of ALLOWED) {
      expect(a.reason.length, `${a.file}: ${a.text} has no reason`).toBeGreaterThan(20)
      expect(
        sites.some((site) => site.startsWith(`${a.file}:`) && site.includes(a.text)),
        `allowlist entry ${a.file} ${a.text} matches no site: remove it`,
      ).toBe(true)
    }
  })
})

/** Guard against a test signalling a pid it merely recorded. A pid read from a file, a heartbeat, a status listing or an earlier `alive` probe is a claim: the OS hands a freed number to the next process it starts, and on Windows process.kill(pid, 'SIGKILL') and taskkill are TerminateProcess(handle, 1), so the kill of a pid that had already exited ends whatever holds the number now. That is how a vitest worker forked a moment earlier died with "Worker exited unexpectedly with exit code 1 during started state" in a file that had nothing to do with the kill. A test signals a child through the ChildProcess handle it owns (the handle signals the process it holds and nothing once that has exited), or through killIfCommandLine in tests/helpers/kill_if_command_line.ts, which reads the command line immediately before the signal. This scan fails on any other signal (process.kill with a signal other than 0, a process-group kill, a taskkill, terminateProcessTree, killProcessTree) whose target is not the pid of a handle bound in the same file. Provenance: HAND-DERIVED; the planted sites below are written from the rule, and the allowlist is read off the tree on 2026-10-17. What the scan cannot see: a command built in a variable (`execSync(cmd)`, `spawn(bin, args)` with a non-literal program), a kill alias that crosses a module or a function parameter, a script file that kills, and `child` bindings are file-wide rather than scoped to a function. A computed `process[key](...)`, `process.kill.call/apply/bind` fail closed: they are flagged. A bare `process.kill` passed around as a value (an argument, an object field) is not followed: sampled on 2026-10-17 it matched 4 sites, 3 of them type casts or prose, so that rule was dropped. Round 4 folds `globalThis.process`, a cast `(process as X)` or `(<X>process)`, and optional chaining onto the plain spelling before any rule reads a line; follows `const proc = process` (also `globalThis.process`, `require('node:process')`, a default or namespace import) and a kill taken or destructured from it, or from `require`/`import()` of `node:process`; and reads PowerShell `Stop-Process`, `spps` and `kill` inside a command string or the argv of a `powershell`/`pwsh` call. Round 4c reads a destructure or import that spans lines, a call through a member (`require('node:child_process').execSync(...)`), an import or destructure alias of a child_process function (`import { execSync as sh }`), and a kill program behind `sudo`, `xargs`, `env`, `nohup`, `command`, `exec`, `time`, `nice`, `setsid`, `doas` or after a `(`, `{`, `$(` or backtick. Still not seen, because no sound textual rule exists: a wrapper option that takes a value (`sudo -u root kill`), `const { execSync } = cp` taken off a namespace, an alias of spawnOwned, `proc = process` assigned after its declaration, `cond ? process : x`, `(0, process.kill)(pid)`, `Reflect.apply(process.kill, ...)`, a cast over several lines, a PowerShell command held in a variable or script file, and `Stop-Process -Name`/`-InputObject` (flagged like `-Id`, since the target cannot be told from a recorded pid). */

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
  { file: 'worker.test.ts', text: 'process.kill.bind(process)', reason: 'a spy that forwards to the real kill only what claimWorkerPidFile sends it, which is the signal-0 liveness probe of src/worker_lifecycle.ts:111, for pid 999999999' },
  { file: 'resident_process.test.ts', text: 'terminateProcessTree(pid, true)', reason: 'the refusal cases: pids 0, 1, -1 and this process and its parent must be refused, so nothing is signalled' },
]

/** This file's own planted bad sites are text, not kills. */
const SELF = 'guards/tests_do_not_signal_recorded_pids.test.ts'

const CODE_EXT = /\.(?:ts|mts|mjs|cjs|js)$/

/** The code half of a line: a whole-line comment and a trailing ` // ...` comment are cut off, so prose that mentions a kill never matches. */
function codeOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  const at = line.search(/\s\/\/\s/)
  return normalizeSpelling(at === -1 ? line : line.slice(0, at))
}

/** Spellings that reach the same member without changing what is called: `globalThis.process`, a parenthesised cast `(process as X)` or `(<X>process)`, a non-null `(process!)`, and optional chaining (`process?.kill`, `process.kill?.(...)`). They are folded onto the plain form, so every rule below sees one spelling. */
function normalizeSpelling(code: string): string {
  return code
    .replace(/\bglobalThis\.process\b/g, 'process')
    .replace(/\(\s*([A-Za-z_$][\w$.]*)\s+as\s+(?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\(\s*<[^>]*>\s*([A-Za-z_$][\w$.]*)\s*\)/g, '$1')
    .replace(/\(\s*([A-Za-z_$][\w$.]*)\s*!\s*\)/g, '$1')
    .replace(/\?\.\(/g, '(')
    .replace(/\?\.\[/g, '[')
    .replace(/\?\.(?=[A-Za-z_$])/g, '.')
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

/** Names this file binds to a child process it owns: assigned from a spawning call (spawn, fork, execFile, spawnOwned's `.child`) or typed ChildProcess. Nothing is assumed by name: a `child` that no spawn in the file bound is not a handle. A pid read off one of these is the handle's own. */
function handleNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>()
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
  if (owner.endsWith('.child') && handles.has(owner.slice(0, -'.child'.length).split('.').pop()!)) return true
  return handles.has(owner) || handles.has(owner.split('.').pop()!)
}

/** The pid expression of a `${...}` or `String(...)` inside a taskkill argument list, or the whole argument when it is a bare identifier or member. */
function taskkillTargets(args: string): string[] {
  const out: string[] = []
  for (const m of args.matchAll(/String\(([^()]*)\)/g)) out.push(bareTarget(m[1]!))
  for (const m of args.matchAll(/\$\{([^}]*)\}/g)) out.push(bareTarget(m[1]!))
  return out
}

/** `process` itself, as a module: `require('node:process')` or `import('node:process')`. */
const PROCESS_MODULE = String.raw`(?:require|import)\(\s*['"](?:node:)?process['"]\s*\)`

/** Names a file binds to the process object: `process` itself, and `const proc = process`, `const proc = require('node:process')`, `import proc from 'node:process'`, `import * as proc from 'node:process'`. A call through one of them is a call on process. */
function processNames(lines: readonly string[]): string[] {
  const names = new Set<string>(['process'])
  for (const line of lines) {
    const code = codeOf(line)
    for (const m of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>]+\s*)?=\s*(?:await\s+)?(?:process|${PROCESS_MODULE})(?:\s+as\s+[\w.]+)?\s*(?:;|$)`, 'g'))) names.add(m[1]!)
    for (const m of code.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"](?:node:)?process['"]/g)) names.add(m[1]!)
  }
  return [...names]
}

/** A regex source matching any of `names` as a whole identifier. */
const anyOf = (names: readonly string[]): string => `(?:${names.map((n) => n.replace(/\$/g, '\\$')).join('|')})`

/** Names a file binds to `process.kill` itself: `const { kill } = process`, `const { kill: stop } = process`, `const { kill } = require('node:process')`, `const k = process.kill`, `import { kill } from 'node:process'`; `procs` are the names bound to the process object. A call through one of them is a process.kill call. */
function killAliases(lines: readonly string[], procs: readonly string[]): Set<string> {
  const names = new Set<string>()
  const fromBraces = (body: string): void => {
    for (const part of body.split(',')) {
      const [key, local] = part.split(':').map((x) => x.trim())
      if (key === 'kill') names.add(local === undefined || local === '' ? key : local)
    }
  }
  const source = anyOf(procs)
  const destructure = new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:${source}\b(?!\.)|${PROCESS_MODULE})`, 'g')
  const decl = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${source}\.kill\s*(?:;|$)`, 'gm')
  const code = lines.map(codeOf).join('\n')
  for (const m of code.matchAll(destructure)) fromBraces(m[1]!)
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"](?:node:)?process['"]/g)) fromBraces(m[1]!.replace(/\bkill\s+as\s+/, 'kill:'))
  for (const m of code.matchAll(decl)) names.add(m[1]!)
  return names
}

/** The spawning and exec functions of node:child_process. */
const SPAWN_NAMES: readonly string[] = ['execFileSync', 'execFile', 'execSync', 'exec', 'spawnSync', 'spawnOwned', 'spawn']

/** The child_process module, as a specifier: `'node:child_process'` or `'child_process'`. */
const CHILD_PROCESS_MODULE = String.raw`['"](?:node:)?child_process['"]`

/** Local names a file binds to a spawning or exec function of node:child_process under another name: `import { execSync as sh } from 'node:child_process'` and `const { execSync: sh } = require('node:child_process')`, over as many lines as the braces take. */
function spawnAliases(lines: readonly string[]): string[] {
  const names = new Set<string>()
  const fromBraces = (body: string, separator: RegExp): void => {
    for (const part of body.split(',')) {
      const [key, local] = part.split(separator).map((x) => x.trim())
      if (key !== undefined && SPAWN_NAMES.includes(key) && local !== undefined && local !== '') names.add(local)
    }
  }
  const code = lines.map(codeOf).join('\n')
  for (const m of code.matchAll(new RegExp(String.raw`\bimport\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*${CHILD_PROCESS_MODULE}`, 'g'))) fromBraces(m[1]!, /\s+as\s+/)
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require|import)\(\s*${CHILD_PROCESS_MODULE}\s*\)`, 'g'))) fromBraces(m[1]!, /:/)
  return [...names]
}

const KILL_PROGRAM = /^(?:taskkill(?:\.exe)?|pkill|killall|kill|stop-process|spps)$/i

/** A program literal that runs PowerShell text, the shell whose `Stop-Process` (and its aliases `spps` and `kill`) ends a pid. */
const POWERSHELL_PROGRAM = /^(?:.*[\\/])?(?:powershell|pwsh)(?:\.exe)?(?:\s|$)/i

/** A PowerShell stop command anywhere in a script literal, not only at the start of a segment: `try { Stop-Process -Id 1 }`, `Get-Process | kill`. */
const POWERSHELL_STOP = /(?:^|[\s;|&({"'])(?:stop-process|spps|kill)(?=\s|$)/i

/** A call to one of `names`, bare or as a member of anything: `execSync(`, `cp.execSync(`, `require('node:child_process').execSync(`. */
const callsTo = (names: readonly string[]): RegExp => new RegExp(String.raw`(?:^|[^\w$])${anyOf(names)}\(`, 'g')

/** Programs that run the command after them: `sudo kill 1`, `echo 1 | xargs kill`, `env X=1 kill 1`. */
const WRAPPER_PROGRAM = /^(?:sudo|doas|xargs|env|nohup|command|exec|time|nice|setsid)$/i

/** True when `command`, read as shell text, starts any segment with a kill program (path and `.exe` allowed), also behind a wrapper program, its options and its `NAME=value` words, or after a `(`, `{`, `$(` or backtick. */
function runsKillProgram(command: string): boolean {
  const programOf = (word: string): string => word.replace(/^.*[\\/]/, '')
  return command.split(/[;&|\n(){}`]+/).some((segment) => {
    const words = segment.trim().replace(/^!\s*/, '').split(/\s+/)
    let at = 0
    while (WRAPPER_PROGRAM.test(programOf(words[at] ?? ''))) {
      at++
      while (/^(?:-\S*|\w+=\S*)$/.test(words[at] ?? '')) at++
    }
    return KILL_PROGRAM.test(programOf(words[at] ?? ''))
  })
}

/** The contents of every string, template and character literal in `text`. */
function stringLiterals(text: string): string[] {
  return [...text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]!)
}

/** One entry per site in `source` that signals a pid which is not a handle's own: `file:line: text`. */
function flaggedSites(file: string, source: string): string[] {
  const lines = source.split(/\r?\n/)
  const handles = handleNames(lines)
  const procs = processNames(lines)
  const aliases = killAliases(lines, procs)
  const proc = anyOf(procs)
  const spawnCalls = callsTo([...SPAWN_NAMES, ...spawnAliases(lines)])
  const found: string[] = []
  const flag = (i: number): void => void found.push(`${file}:${i + 1}: ${lines[i]!.trim()}`)
  /** The call whose opening parenthesis is at `lines[i][open]` is a process.kill: a probe or a handle's pid passes. */
  const checkKill = (i: number, open: number): void => {
    const args = splitArgs(callText(lines, i, open))
    if (args[1] === '0') return
    if (!isHandlePid(bareTarget(args[0] ?? ''), handles)) flag(i)
  }
  lines.forEach((line, i) => {
    const code = codeOf(line)
    for (const m of code.matchAll(new RegExp(String.raw`(?:^|[^\w$.])${proc}\.kill\(`, 'g'))) checkKill(i, m.index + m[0].length - 1)
    for (const name of aliases) {
      for (const m of code.matchAll(new RegExp(`(?:^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\(`, 'g'))) checkKill(i, m.index + m[0].length - 1)
    }
    for (const m of code.matchAll(new RegExp(String.raw`(?:^|[^\w$.])${proc}\[\s*([^\]]*?)\s*\]\(`, 'g'))) {
      const literal = /^(['"`])(.*)\1$/.exec(m[1]!)
      if (literal === null) flag(i)
      else if (literal[2] === 'kill') checkKill(i, m.index + m[0].length - 1)
    }
    if (new RegExp(String.raw`(?:^|[^\w$.])${proc}\.kill\.(?:call|apply|bind)\(`).test(code)) flag(i)
    for (const m of code.matchAll(spawnCalls)) {
      const text = callText(lines, i, m.index + m[0].length - 1)
      const literals = stringLiterals(text)
      const viaPowerShell = literals.some((l) => POWERSHELL_PROGRAM.test(l))
      if (!literals.some((l) => runsKillProgram(l) || (viaPowerShell && POWERSHELL_STOP.test(l)))) continue
      const targets = taskkillTargets(text)
      if (targets.length === 0 || targets.some((t) => !isHandlePid(t, handles))) flag(i)
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

  // HAND-DERIVED: each spelling is a way to reach the same signal that the plain `process.kill(pid, ...)` form does, written from the rule, not read off a tree. Review 1 of this guard listed the first six as missed.
  const BAD_FORMS: ReadonlyArray<readonly [string, readonly string[], number]> = [
    ['a destructured kill', ["const { kill } = process", "kill(pid, 'SIGKILL')"], 2],
    ['a renamed destructured kill', ["const { kill: stop } = process", "stop(pid, 'SIGKILL')"], 2],
    ['an aliased process.kill', ['const k = process.kill', "k(pid, 'SIGKILL')"], 2],
    ['a computed literal key', ["process['kill'](pid, 'SIGKILL')"], 1],
    ['a computed variable key', ["process[method](pid, 'SIGKILL')"], 1],
    ['process.kill.call', ["process.kill.call(process, pid, 'SIGKILL')"], 1],
    ['a taskkill in a command string', ['execSync(`taskkill /F /PID ${pid}`)'], 1],
    ['a kill in a command string', ['execSync(`kill -9 ${pid}`)'], 1],
    ['a literal pid in a command string', ["execSync('kill -9 4242')"], 1],
    ['a kill in a shell script argument', ["spawn('sh', ['-c', `kill -9 ${pid}`])"], 1],
    ['execFileSync of kill', ["execFileSync('kill', ['-9', String(pid)])"], 1],
    ['spawnSync of kill', ["spawnSync('kill', ['-9', String(pid)])"], 1],
    ['a qualified spawnSync of kill', ["cp.spawnSync('kill', ['-TERM', String(pid)])"], 1],
  ]
  it.each(BAD_FORMS)('flags %s', (_name, source, line) => {
    expect(flaggedSites('a.ts', source.join('\n')).map((s) => s.split(':')[1])).toEqual([String(line)])
  })

  // HAND-DERIVED: round 4 of this guard; review 2 listed these forms as missed. Each is a way to reach the same signal as `process.kill(pid, ...)` that the plain-text rule did not read.
  const MISSED_FORMS: ReadonlyArray<readonly [string, readonly string[], number]> = [
    ['globalThis.process.kill', ["globalThis.process.kill(pid, 'SIGKILL')"], 1],
    ['a cast process', ["(process as NodeJS.Process).kill(pid, 'SIGKILL')"], 1],
    ['a cast through unknown to a literal type', ["(process as unknown as { kill(p: number): void }).kill(pid)"], 1],
    ['an angle-bracket cast process', ["(<any>process).kill(pid)"], 1],
    ['a cast globalThis.process', ["(globalThis.process as NodeJS.Process).kill(pid)"], 1],
    ['an optional-chained process', ["process?.kill(pid, 'SIGKILL')"], 1],
    ['an optional-chained kill call', ["process.kill?.(pid, 'SIGKILL')"], 1],
    ['an optional-chained computed key', ["process?.['kill'](pid, 'SIGKILL')"], 1],
    ['a kill destructured from require', ["const { kill } = require('node:process')", "kill(pid, 'SIGKILL')"], 2],
    ['a renamed kill destructured from require', ["const { kill: stop } = require('process')", "stop(pid, 'SIGKILL')"], 2],
    ['a kill destructured from a dynamic import', ["const { kill } = await import('node:process')", "kill(pid, 'SIGKILL')"], 2],
    ['a kill imported by name', ["import { kill } from 'node:process'", "kill(pid, 'SIGKILL')"], 2],
    ['a kill imported under another name', ["import { kill as stop } from 'node:process'", "stop(pid, 'SIGKILL')"], 2],
    ['a namespace import of process', ["import * as proc from 'node:process'", "proc.kill(pid, 'SIGKILL')"], 2],
    ['a default import of process', ["import proc from 'node:process'", "proc.kill(pid, 'SIGKILL')"], 2],
    ['process bound to another name', ['const proc = process', "proc.kill(pid, 'SIGKILL')"], 2],
    ['globalThis.process bound to another name', ['const proc = globalThis.process', "proc.kill(pid, 'SIGKILL')"], 2],
    ['process required under another name', ["const proc = require('node:process')", "proc.kill(pid, 'SIGKILL')"], 2],
    ['a computed key on a process alias', ['const proc = process', "proc['kill'](pid, 'SIGKILL')"], 2],
    ['kill.call on a process alias', ['const proc = process', "proc.kill.call(proc, pid, 'SIGKILL')"], 2],
    ['a kill destructured from a process alias', ['const proc = process', 'const { kill } = proc', "kill(pid, 'SIGKILL')"], 3],
    ['a kill taken off a process alias', ['const proc = process', 'const k = proc.kill', "k(pid, 'SIGKILL')"], 3],
    ['Stop-Process in a command string', ['execSync(`powershell -Command "Stop-Process -Id ${pid} -Force"`)'], 1],
    ['Stop-Process in a powershell argv', ["spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid}`])"], 1],
    ['Stop-Process in a pwsh argv, upper case', ["spawn('pwsh', ['-c', `STOP-PROCESS -Id ${pid}`])"], 1],
    ['the spps alias in a powershell argv', ["spawn('pwsh', ['-c', `spps ${pid}`])"], 1],
    ['the kill alias inside a powershell script block', ['execSync(`powershell -c "try { kill ${pid} } catch {}"`)'], 1],
    ['a literal pid to Stop-Process', ["execSync('powershell -c \"Stop-Process -Id 4242\"')"], 1],
    ['Stop-Process at the start of an exec string', ['execSync(`Stop-Process -Id ${pid}`)'], 1],
  ]
  it.each(MISSED_FORMS)('flags %s', (_name, source, line) => {
    expect(flaggedSites('a.ts', source.join('\n')).map((s) => s.split(':')[1])).toEqual([String(line)])
  })

  // HAND-DERIVED: round 4c of this guard; review 3 listed these forms as missed. Each reaches the same signal as the plain form through a spelling the line-by-line rules did not read.
  const ROUND_4C_FORMS: ReadonlyArray<readonly [string, readonly string[], number]> = [
    ['a destructure over several lines', ['const {', '  kill,', '} = process', "kill(pid, 'SIGKILL')"], 4],
    ['a renamed destructure over several lines', ['const {', '  kill: stop,', '} = process', "stop(pid, 'SIGKILL')"], 4],
    ['a kill behind xargs', ["execSync('echo 1 | xargs kill -9')"], 1],
    ['a kill behind xargs and its options', ["execSync('echo 1 | xargs -n1 kill -9')"], 1],
    ['a kill behind sudo', ["execSync('sudo kill -9 1234')"], 1],
    ['a kill behind env and an assignment', ["execSync('env LANG=C kill -9 1234')"], 1],
    ['a kill behind nohup', ["execSync('nohup kill -9 1234')"], 1],
    ['a kill behind command', ["execSync('command kill -9 1234')"], 1],
    ['a kill in parentheses', ["execSync('( kill -9 1234 )')"], 1],
    ['a kill in a command substitution', ["execSync('echo $(kill -9 1234)')"], 1],
    ['a kill in braces', ["execSync('{ kill -9 1234; }')"], 1],
    ['a call through require', ["require('node:child_process').execSync('kill -9 1234')"], 1],
    ['a call through a dynamic import', ["(await import('node:child_process')).execSync('kill -9 1234')"], 1],
    ['an import alias', ["import { execSync as sh } from 'node:child_process'", "sh('kill -9 1234')"], 2],
    ['an import alias among others', ["import { spawn, execSync as sh } from 'child_process'", "sh('kill -9 1234')"], 2],
    ['an import alias over several lines', ["import {", "  execSync as sh,", "} from 'node:child_process'", "sh('kill -9 1234')"], 4],
    ['a destructured alias of require', ["const { execSync: sh } = require('node:child_process')", "sh('kill -9 1234')"], 2],
    ['a destructured alias over several lines', ['const {', '  spawnSync: run,', "} = require('child_process')", "run('kill', ['-9', String(pid)])"], 4],
  ]
  it.each(ROUND_4C_FORMS)('flags %s', (_name, source, line) => {
    expect(flaggedSites('a.ts', source.join('\n')).map((s) => s.split(':')[1])).toEqual([String(line)])
  })

  it('accepts the round 4c spellings when nothing is killed or the target is a handle', () => {
    const good = [
      "const child = spawn(process.execPath, ['-e', '0'])",
      'execSync(`sudo kill -9 ${child.pid}`)',
      "execSync('xargs echo kill')",
      "execSync('sudo echo kill')",
      "execSync('(echo kill)')",
      "require('node:child_process').execSync('git status')",
      "import { execSync as sh } from 'node:child_process'",
      "sh('git status')",
      "import { readFileSync as read } from 'node:fs'",
      "read('kill -9 1234')",
    ].join('\n')
    expect(flaggedSites('a.ts', good)).toEqual([])
  })

  it('accepts the missed spellings when the target is a handle the file owns, or a probe', () => {
    const good = [
      "const child = spawn(process.execPath, ['-e', '0'])",
      "globalThis.process.kill(child.pid as number, 'SIGKILL')",
      "(process as NodeJS.Process).kill(child.pid as number, 'SIGTERM')",
      "process?.kill(child.pid as number, 'SIGKILL')",
      "process.kill?.(child.pid as number, 'SIGKILL')",
      'process.kill?.(pid, 0)',
      'globalThis.process.kill(pid, 0)',
      'const proc = process',
      'proc.kill(pid, 0)',
      "proc.kill(child.pid as number, 'SIGKILL')",
      "const { kill } = require('node:process')",
      'kill(pid, 0)',
      "spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${child.pid}`])",
      "execSync('powershell -Command \"Get-Process -Id 4\"')",
      "execSync('echo Stop-Process')",
    ].join('\n')
    expect(flaggedSites('a.ts', good)).toEqual([])
  })

  // HAND-DERIVED: a name that holds a ChildProcess, not the process object, is not process: its kill() signals the handle's own process.
  it('does not treat a variable named proc that holds a spawn result as the process object', () => {
    const good = ["const proc = spawn(process.execPath, ['-e', '0'])", "proc.kill('SIGKILL')", 'const other = makeThing()', "other.kill(pid, 'SIGKILL')"].join('\n')
    expect(flaggedSites('a.ts', good)).toEqual([])
  })

  it('accepts the same spellings when the target is a handle the file owns, or a probe', () => {
    const good = [
      "const child = spawn(process.execPath, ['-e', '0'])",
      'const { kill } = process',
      "kill(child.pid as number, 'SIGTERM')",
      'kill(pid, 0)',
      'const k = process.kill',
      "k(child.pid as number, 'SIGKILL')",
      "process['kill'](child.pid as number, 'SIGKILL')",
      'execSync(`taskkill /F /PID ${child.pid}`)',
      "execFileSync('kill', ['-9', String(child.pid)])",
      "execSync('echo kill the build')",
      "spawnSync('git', ['status'])",
    ].join('\n')
    expect(flaggedSites('a.ts', good)).toEqual([])
  })

  // HAND-DERIVED: `child` is only a handle where the file binds it to a spawn, fork or exec result; a name that merely looks like one is the stale-pid hazard itself.
  it('does not treat a child that no spawn bound as a handle', () => {
    const bad = ['const child = { pid: Number(fs.readFileSync(f, "utf8")) }', "process.kill(child.pid, 'SIGKILL')"].join('\n')
    expect(flaggedSites('a.ts', bad).map((s) => s.split(':')[1])).toEqual(['2'])
    const badThis = ['this.child = readRecord()', "process.kill(this.child.pid, 'SIGKILL')"].join('\n')
    expect(flaggedSites('a.ts', badThis).map((s) => s.split(':')[1])).toEqual(['2'])
  })

  it('treats a child that a spawn bound as a handle, on a field too', () => {
    const good = ["this.child = spawn(process.execPath, ['-e', '0'])", "process.kill(this.child.pid as number, 'SIGKILL')", "const child = await spawnOwned('sh', [])", "process.kill(child.pid as number, 'SIGKILL')"].join('\n')
    expect(flaggedSites('a.ts', good)).toEqual([])
  })

  it('reads a call that runs over several lines', () => {
    const bad = ['process.kill(', '  recorded,', "  'SIGKILL',", ')'].join('\n')
    expect(flaggedSites('a.ts', bad)).toEqual(['a.ts:1: process.kill('])
  })
})

describe('no test signals a pid it only recorded', () => {
  it('finds every signalling site on a handle, a probe, or the allowlist', () => {
    const files = testFiles().filter((rel) => rel !== SELF)
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

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { powerShellCommandArgs } from '../../src/shell.js'
import { pinnedPopulation } from './population.js'

// HAND-DERIVED: the required flags and forbidden history names come from the owner's rule, not the scanner.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SCANNED_DIRS = ['src', 'scripts']
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

// Callees that start a process, by their own name or by an alias imported under another name.
const SPAWN_NAMES = new Set(['spawn', 'spawnSync', 'spawnOwned', 'exec', 'execSync', 'execFile', 'execFileSync', 'query'])

// Helpers that return a PowerShell executable path.
const PATH_HELPERS = new Set(['windowsPowerShellPath', 'resolvePowerShell'])

// Helpers whose argv carries both non-interactive flags; the builder test below pins that.
const ARGV_BUILDERS = new Set(['powerShellCommandArgs', 'powerShellTextQueryArgs'])

// A literal that is the executable itself: powershell or pwsh, optional .exe, any case, any directory.
const EXECUTABLE = /^(?:.*[\\/])?(?:powershell|pwsh)(?:[.]exe)?$/i

// A command string: a command segment that starts with the executable and a dash flag, as a hook line does.
const COMMAND_LINE = /(?:^|[&;|("'])\s*(?:&\s*)?(?:powershell|pwsh)(?:[.]exe)?\s+-/im

// -NoExit, and any prefix PowerShell accepts for it (-NoE, -NoEx).
const NO_EXIT = /-noe\w*/i

// Add-History, a PSReadLine directory path, or a *_history.txt file name.
const HISTORY = /Add-History|PSReadLine[\\/]|_history[.]txt|ConsoleHost_history/i

interface Decl {
  readonly scope: ts.Node
  readonly init: ts.Expression
}

interface Scope {
  readonly decls: ReadonlyMap<string, readonly Decl[]>
  readonly aliases: ReadonlySet<string>
}

// The nearest enclosing function, block or file: the scope a `const` or `let` is visible in.
function isScope(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)
}

function scopeOf(node: ts.Node): ts.Node {
  let at: ts.Node = node
  while (!isScope(at)) at = at.parent
  return at
}

// The initializers a name refers to from `at`: the innermost enclosing scope that declares it.
function initsOf(name: string, at: ts.Node, decls: ReadonlyMap<string, readonly Decl[]>): ts.Expression[] {
  const named = decls.get(name) ?? []
  for (let scope: ts.Node | undefined = at; scope !== undefined; scope = scope.parent) {
    if (!isScope(scope)) continue
    const here = named.filter((d) => d.scope === scope).map((d) => d.init)
    if (here.length > 0) return here
  }
  return []
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return undefined
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')
  return undefined
}

// True for a node that is a literal spelling the executable, or a helper that returns its path.
function namesPowerShell(node: ts.Node): boolean {
  const literal = literalText(node)
  if (literal !== undefined) return EXECUTABLE.test(literal.trim())
  return ts.isIdentifier(node) && PATH_HELPERS.has(node.text)
}

// Every node under `root`, following an identifier to the initializers its declaration gives it.
function reachable(root: ts.Node, scope: Scope): ts.Node[] {
  const seen = new Set<ts.Node>()
  const out: ts.Node[] = []
  const walk = (n: ts.Node): void => {
    out.push(n)
    if (ts.isIdentifier(n)) {
      for (const init of initsOf(n.text, n, scope.decls)) {
        if (!seen.has(init)) {
          seen.add(init)
          walk(init)
        }
      }
    }
    n.forEachChild(walk)
  }
  walk(root)
  return out
}

// The non-interactive flags a text lacks, plus -NoExit when it carries one.
function flagProblems(text: string): string[] {
  const problems: string[] = []
  if (!/-noprofile\b/i.test(text)) problems.push('missing -NoProfile')
  if (!/-noninteractive\b/i.test(text)) problems.push('missing -NonInteractive')
  if (NO_EXIT.test(text)) problems.push('has -NoExit')
  return problems
}

// Findings for one source file as `file:line problem`; a text scan would miss aliases and templates.
function scanSource(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const decls = new Map<string, Decl[]>()
  const aliases = new Set<string>()
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      decls.set(n.name.text, [...(decls.get(n.name.text) ?? []), { scope: scopeOf(n), init: n.initializer }])
    }
    if (ts.isImportSpecifier(n) && SPAWN_NAMES.has((n.propertyName ?? n.name).text)) aliases.add(n.name.text)
    if (ts.isBindingElement(n) && n.propertyName !== undefined && ts.isIdentifier(n.name) && ts.isIdentifier(n.propertyName) && SPAWN_NAMES.has(n.propertyName.text)) {
      aliases.add(n.name.text)
    }
    n.forEachChild(collect)
  }
  collect(sf)
  const scope: Scope = { decls, aliases }
  const found: string[] = []
  const at = (n: ts.Node): string => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`
  const checkSpawn = (call: ts.CallExpression): void => {
    const name = calleeName(call.expression)
    const [target, ...argv] = call.arguments
    if (name === undefined || target === undefined || !(SPAWN_NAMES.has(name) || aliases.has(name))) return
    if (!reachable(target, scope).some(namesPowerShell)) return
    const nodes = argv.flatMap((arg) => reachable(arg, scope))
    const builder = nodes.some((n) => ts.isCallExpression(n) && ARGV_BUILDERS.has(calleeName(n.expression) ?? ''))
    const argvText = nodes.map(literalText).filter((t): t is string => t !== undefined).join(' ')
    for (const problem of flagProblems(argvText).filter((p) => !builder || p === 'has -NoExit')) {
      found.push(`${at(call)} PowerShell spawn ${problem}`)
    }
  }
  const checkText = (n: ts.Node, literal: string): void => {
    if (COMMAND_LINE.test(literal)) {
      for (const problem of flagProblems(literal)) found.push(`${at(n)} command string naming PowerShell ${problem}`)
    }
    if (HISTORY.test(literal)) found.push(`${at(n)} names Add-History or a PSReadLine history file`)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) checkSpawn(n)
    const literal = literalText(n)
    if (literal !== undefined) checkText(n, literal)
    n.forEachChild(visit)
  }
  visit(sf)
  return found
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(path.relative(ROOT, full).split(path.sep).join('/'))
  }
  return out
}

const population = pinnedPopulation({
  what: 'src/ and scripts/ source files',
  items: SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir))),
  floor: 500,
  mustInclude: ['src/shell.ts', 'src/windows_powershell.ts', 'scripts/post-merge.mjs'],
})

const VIOLATIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['a spawn of pwsh.exe without -NonInteractive', ["import { spawnSync } from 'node:child_process'", "spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'Get-Date'])"]],
  ['an aliased spawnSync launching PowerShell.EXE with -NoExit', ["import { spawnSync as run } from 'node:child_process'", "run('PowerShell.EXE', ['-NoProfile', '-NonInteractive', '-NoExit', '-Command', 'x'])"]],
  ['a template-string launch with no flags', ["import { spawn } from 'node:child_process'", "spawn(`pwsh`, ['-Command', 'x'])"]],
  ['a path helper passed to a spawn with a bare argv', ["import { spawnSync } from 'node:child_process'", 'const file = windowsPowerShellPath()', "spawnSync(file, ['-Command', 'x'])"]],
  ['a command string naming powershell without flags', ['const cmd = \'powershell -Command "Get-Date"\'']],
  ['a command string carrying -NoExit', ['const cmd = \'powershell -NoProfile -NonInteractive -NoExit -Command "x"\'']],
  ['a call to Add-History', ["const script = 'Get-Date | Add-History'"]],
  ['a PSReadLine history path', ["const file = 'PSReadLine/ConsoleHost_history.txt'"]],
]

const NEAR_MISSES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['the shared helper launch', ["import { spawnSync } from 'node:child_process'", "import { windowsPowerShellPath, powerShellTextQueryArgs } from './windows_powershell.js'", "spawnSync(windowsPowerShellPath(), powerShellTextQueryArgs('x'))"]],
  ['a shell kind passed to a hook builder', ["const shell = process.platform === 'win32' ? 'powershell' : 'sh'", "nativeHookCommandLine(shell, bin, 'grok')"]],
  ['a flagged command string', ['const cmd = \'powershell -NoProfile -NonInteractive -Command "Get-Date"\'']],
  ['a non-PowerShell spawn', ["import { spawnSync } from 'node:child_process'", "spawnSync('git', ['status', '--short'])"]],
  ['a RegExp exec on a PowerShell pattern', ['const wrap = /(?:powershell|pwsh)\\s+-Command/i', "wrap.exec('x')"]],
]

describe('PowerShell that token-goat starts runs non-interactively and writes no history', () => {
  it('every spawn and command string under src/ and scripts/ carries the flags', () => {
    const findings = population.flatMap((rel) => scanSource(rel, readFileSync(path.join(ROOT, rel), 'utf8')))
    expect(findings).toEqual([])
  })

  it('the shared builder passes both flags and no -NoExit', () => {
    expect(flagProblems(powerShellCommandArgs('x').join(' '))).toEqual([])
  })

  it.each(VIOLATIONS)('flags %s', (_name, lines) => {
    expect(scanSource('fixture.ts', lines.join('\n'))).not.toEqual([])
  })

  it.each(NEAR_MISSES)('allows %s', (_name, lines) => {
    expect(scanSource('fixture.ts', lines.join('\n'))).toEqual([])
  })
})

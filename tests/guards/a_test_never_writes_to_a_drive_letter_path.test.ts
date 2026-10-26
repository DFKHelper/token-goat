/** Guard: a test that writes to the filesystem never passes a drive-letter absolute path literal (`'C:/...'`), directly or through a file-level const it was assigned from, because on Linux that spelling is a relative path, so the asserted location never matches (tests/shell_write_requests.test.ts probePair, commit d851645f6, failed 5 rows on the WSL leg). A string argument to a product function is not a write and is not flagged, and the scan reads the AST, so a comment or a string that only mentions a write is not flagged either. */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const TESTS = path.resolve(HERE, '..')

const FS_WRITE_CALLS = new Set([
  'mkdirSync', 'mkdtempSync', 'writeFileSync', 'rmSync', 'cpSync', 'renameSync',
  'mkdir', 'mkdtemp', 'writeFile', 'rm', 'cp', 'rename',
])
/** The calls whose first two arguments are both paths (a source and a destination). */
const TWO_PATH_CALLS = new Set(['cpSync', 'renameSync', 'cp', 'rename'])
const DRIVE_PATH = /^[A-Za-z]:[\\/]/

type Finding = { file: string; line: number; call: string; text: string }

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'fixtures') continue
    if (entry.isDirectory()) out.push(...testFiles(p))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function fsWriteName(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
  return name !== undefined && FS_WRITE_CALLS.has(name) ? name : undefined
}

type Binding = { init: ts.Expression; scope: ts.Node }

/** The nearest enclosing block, function or file: the region a `const` declared there is visible in. */
function scopeOf(node: ts.Node): ts.Node | undefined {
  let cur = node.parent
  while (cur !== undefined && !(ts.isSourceFile(cur) || ts.isBlock(cur) || ts.isFunctionLike(cur) || ts.isCaseBlock(cur) || ts.isModuleBlock(cur))) cur = cur.parent
  return cur
}

function collectConsts(sf: ts.SourceFile): Map<string, Binding[]> {
  const consts = new Map<string, Binding[]>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const scope = scopeOf(node)
      if (scope !== undefined) consts.set(node.name.text, [...(consts.get(node.name.text) ?? []), { init: node.initializer, scope }])
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return consts
}

function isVisibleFrom(scope: ts.Node, use: ts.Node): boolean {
  for (let cur: ts.Node | undefined = use; cur !== undefined; cur = cur.parent) {
    if (cur === scope) return true
  }
  return false
}

function isDriveStringLiteral(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return DRIVE_PATH.test(node.text)
  if (ts.isTemplateExpression(node)) return DRIVE_PATH.test(node.head.text)
  return false
}

function isPropertyName(node: ts.Identifier): boolean {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
}

/** True when the expression holds a drive-letter literal, or an identifier whose file-level initializer does (followed transitively). */
function reachesDriveLiteral(node: ts.Node, consts: Map<string, Binding[]>, seen: Set<string>): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (isDriveStringLiteral(n)) {
      found = true
      return
    }
    if (ts.isIdentifier(n) && !isPropertyName(n) && !seen.has(n.text)) {
      seen.add(n.text)
      for (const { init, scope } of consts.get(n.text) ?? []) {
        if (isVisibleFrom(scope, n) && reachesDriveLiteral(init, consts, seen)) {
          found = true
          return
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

function scanSource(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const consts = collectConsts(sf)
  const out: Finding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = fsWriteName(node)
      if (name !== undefined) {
        const pathArgs = node.arguments.slice(0, TWO_PATH_CALLS.has(name) ? 2 : 1)
        if (pathArgs.some((arg) => reachesDriveLiteral(arg, consts, new Set()))) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
          out.push({ file, line, call: name, text: node.getText(sf).slice(0, 120) })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

describe('a test never writes to a drive-letter path', () => {
  it('the scanner flags a drive-letter path given to a write, directly, through a const, or through a template, and not a string argument to a product call', () => {
    const flagged = [
      "mkdirSync('C:/tgwt/x', { recursive: true })",
      "const ROOT = 'C:/tgwt/y'\nmkdtempSync(join(ROOT, 'p-'))",
      'rmSync(`C:/tgwt/${name}`, { force: true })',
      "await fsp.writeFile('D:/x/a.txt', 'a')",
      "renameSync('a', 'C:/x')",
    ]
    for (const src of flagged) {
      expect(scanSource('control.ts', src).map((f) => f.call), `flagged: ${src}`).toHaveLength(1)
    }
    const allowed = [
      "makeBashEvent('cat \"C:/Projects/x\"')",
      "writeFileSync(join(dir, 'a.txt'), 'C:/x')",
      "// mkdirSync('C:/x')",
      "mkdirSync('.tmp/x')",
    ]
    for (const src of allowed) {
      expect(scanSource('control.ts', src), `allowed: ${src}`).toEqual([])
    }
  })

  it('no test file passes a drive-letter absolute path literal to a filesystem write', () => {
    const files = testFiles(TESTS)
    pinnedPopulation({
      what: 'test .ts files under tests/ (dot-prefixed, node_modules and fixtures skipped)',
      items: files.map((f) => path.relative(ROOT, f).split(path.sep).join('/')),
      floor: 1400,
      mustInclude: ['tests/shell_write_requests.test.ts'],
    })
    const found = files.flatMap((f) => scanSource(path.relative(TESTS, f), readFileSync(f, 'utf8')))
    expect(found.map((f) => `${f.file}:${f.line} ${f.call}(${f.text})`)).toEqual([])
  })
})

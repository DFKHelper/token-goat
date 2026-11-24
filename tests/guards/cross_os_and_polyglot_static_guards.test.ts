import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { load as loadYaml } from 'js-yaml'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { normalizePath } from '../../src/paths.js'
import { resolveWindowsBash } from '../../src/shell.js'
import { pinnedPopulation } from './population.js'
import { hasUnparenthesizedCaseInCommandSubstitution } from '../helpers/shell_static.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function filesIn(directory: string, extension: string, recursive = false): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory() && recursive) found.push(...filesIn(file, extension, true))
    else if (entry.isFile() && file.endsWith(extension)) found.push(file)
  }
  return found.sort()
}

function pinnedFiles(directory: string, extension: string, floor: number, ceiling: number, recursive = false): string[] {
  const files = filesIn(directory, extension, recursive)
  return [...pinnedPopulation({ what: `${path.relative(ROOT, directory)} ${extension} files`, items: files, floor, ceiling })]
}

function staticStrings(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8')
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const strings: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push(node.text)
    else if (ts.isTemplateExpression(node)) {
      strings.push(node.head.text)
      for (const span of node.templateSpans) strings.push(span.literal.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return strings
}

function stringValue(node: ts.Expression): string | undefined {
  let value = node
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) {
    value = value.expression
  }
  if (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
  if (ts.isArrayLiteralExpression(value) && value.elements.length === 1) {
    const first = value.elements[0]
    return first === undefined || ts.isSpreadElement(first) ? undefined : stringValue(first)
  }
  return undefined
}

function methodName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined) {
    return stringValue(expression.argumentExpression)
  }
  return undefined
}

function isPathRelatedName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/)
  return words.some((word) => ['path', 'home', 'root', 'spec', 'file', 'dir', 'cwd', 'tilde'].includes(word))
}

function isPathRelatedExpression(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return isPathRelatedName(expression.text)
  if (ts.isPropertyAccessExpression(expression)) {
    return isPathRelatedName(expression.name.text) || isPathRelatedExpression(expression.expression)
  }
  if (ts.isElementAccessExpression(expression)) return isPathRelatedExpression(expression.expression)
  return false
}

function isHomePathContext(node: ts.CallExpression): boolean {
  const member = node.expression
  const receiver =
    ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member) ? member.expression : undefined
  if (receiver !== undefined && isPathRelatedExpression(receiver)) return true

  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name !== undefined && isPathRelatedName(parent.name.text)) return true
    if (ts.isMethodDeclaration(parent) && isPathRelatedName(parent.name.getText())) return true
    if (ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) {
      const owner = parent.parent
      if (
        (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner)) &&
        ts.isIdentifier(owner.name) &&
        isPathRelatedName(owner.name.text)
      ) {
        return true
      }
    }
  }
  return false
}

function tildeMatcherCalls(file: string, source = fs.readFileSync(file, 'utf8')): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ['includes', 'indexOf'].includes(methodName(node.expression) ?? '')) {
      const first = node.arguments[0]
      const value = first === undefined ? undefined : stringValue(ts.isSpreadElement(first) ? first.expression : first)
      if (value === '~' && isHomePathContext(node)) {
        found.push(`${path.relative(ROOT, file)}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

function nodeScriptParseErrors(file: string, source: string): string[] {
  const result = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest },
    reportDiagnostics: true,
  })
  return (result.diagnostics ?? []).map(
    (diagnostic) => `${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
  )
}

describe('cross-OS and polyglot static checks', () => {
  it('parses every lefthook shell script with Bash', () => {
    const scripts = pinnedFiles(path.join(ROOT, '.lefthook-scripts'), '.sh', 16, 16)
    const bash = process.platform === 'win32' ? resolveWindowsBash() : 'bash'
    expect(bash, 'Bash is required to validate the shell scripts').not.toBeNull()
    for (const file of scripts) {
      expect(hasUnparenthesizedCaseInCommandSubstitution(fs.readFileSync(file, 'utf8')), path.relative(ROOT, file)).toBe(false)
      const shellPath = normalizePath(file)
      const result = spawnSync(bash!, ['-n', shellPath], { cwd: ROOT, encoding: 'utf8', timeout: 10_000, windowsHide: true })
      expect({ file: path.relative(ROOT, file), status: result.status, stderr: result.stderr, error: result.error?.message }).toMatchObject({
        status: 0,
      })
    }
  })

  it('parses every repository Node script', () => {
    const scripts = pinnedFiles(path.join(ROOT, 'scripts'), '.mjs', 41, 41)
    expect(nodeScriptParseErrors('broken.mjs', 'const = ;')).not.toEqual([])
    const errors = scripts.flatMap((file) => nodeScriptParseErrors(path.relative(ROOT, file), fs.readFileSync(file, 'utf8')))
    expect(errors, 'repository Node scripts must be syntactically valid').toEqual([])
  })

  it('parses every workflow and JSON schema', () => {
    const workflows = pinnedFiles(path.join(ROOT, '.github', 'workflows'), '.yml', 6, 6)
    const schemas = pinnedFiles(path.join(ROOT, 'schemas'), '.json', 1, 1)
    for (const file of workflows) loadYaml(fs.readFileSync(file, 'utf8'), { filename: file })
    for (const file of schemas) JSON.parse(fs.readFileSync(file, 'utf8'))
  })

  it('does not use substring matching for home-tilde checks', () => {
    const sources = pinnedFiles(path.join(ROOT, 'src'), '.ts', 580, 600, true)
    const offenders = sources.flatMap((file) => tildeMatcherCalls(file))
    expect(offenders, 'use equality or a path-boundary prefix for a leading tilde').toEqual([])
  })

  it('distinguishes path checks from language-token scans', () => {
    expect(tildeMatcherCalls('fixture.ts', "function expandSpecPath(path: string) { return path.includes('~') }")).toEqual([
      'fixture.ts:1',
    ])
    expect(
      tildeMatcherCalls('fixture.ts', "function findMultilineOpener(line: string, from: number) { return line.indexOf('~', from) }"),
    ).toEqual([])
  })

  it('keeps shell helper literals compatible with Bash 3.2 case parsing', () => {
    const helpers = pinnedFiles(path.join(ROOT, 'tests', 'helpers'), '.ts', 75, 85)
    const offenders = helpers.flatMap((file) =>
      staticStrings(file)
        .filter(hasUnparenthesizedCaseInCommandSubstitution)
        .map(() => path.relative(ROOT, file)),
    )
    expect(offenders, 'case patterns inside command substitution must start with (').toEqual([])
  })

  it('detects an unparenthesized command-substitution case arm and accepts the compatible form', () => {
    expect(hasUnparenthesizedCaseInCommandSubstitution('value=$(case "$x" in bad) echo ok ;; esac)')).toBe(true)
    expect(hasUnparenthesizedCaseInCommandSubstitution('value=$(case "$x" in (*pat*) echo ok ;; esac)')).toBe(false)
  })

  const hasCargoFmt = spawnSync('cargo', ['fmt', '--version'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000, windowsHide: true }).status === 0

  it.skipIf(!hasCargoFmt)('keeps native/tg-hook Rust sources formatted per rustfmt', () => {
    const check = spawnSync('cargo', ['fmt', '--manifest-path', 'native/tg-hook/Cargo.toml', '--', '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    expect({ status: check.status, stdout: check.stdout, stderr: check.stderr }).toMatchObject({ status: 0 })
  })
})

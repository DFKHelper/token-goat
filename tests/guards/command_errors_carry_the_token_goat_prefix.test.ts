/** Guard: a CLI error -- the stderr message a command prints on its way to a non-zero exit -- is rendered by src/command_error.ts, so it opens with exactly one `token-goat:` and has its file-derived text escaped. Before this guard a few hundred such writes spelled the message out by hand: most printed no prefix at all ("Symbol 'foo' not found in 'nope.ts'", "File not found: x.csv"), a dozen hand-spelled the prefix, and the `{ text, code }` adapters sent a failure's text to stderr raw, so whether an error said who was speaking depended on which command raised it. Rule 1: in any statement list, the run of stderr writes directly above a non-zero exit (a non-zero `return`, `return null`, `throw`, `process.exitCode = N`, `process.exit(N)`), or directly below a `process.exitCode = N`, must open with a write whose argument calls formatCommandError, formatFailedResultText or formatGitFailure (which renders through formatCommandError). Continuation lines after that first write (a did-you-mean, an empty-index note) are deliberately left as they are: the prefix marks where the error starts. Rule 2: a write of a `{ text, code }` result's text to stderr goes through formatFailedResultText, which is what gives that path the same first line. Rule 3: an exit whose code is `<cond> ? 0 : N` (a `return`, or a `process.exitCode =`) fails on one branch, so when its statement list writes prose to stdout above it (a write whose argument is not a JSON rendering) it must also write to stderr there, or be a REPORTS entry whose stdout text is the answer: `refs a,b` printed "a: (no references found)" to stdout and exited 1 with stderr empty. What this cannot see: an error written somewhere other than directly beside its exit (the write in one function, the exit code set by its caller), and an error printed to stdout beside an exit code held in a variable, which carries no sign of whether it can be non-zero. Hook output is out of scope by construction: hooks answer through their JSON envelope and exit 0, so none of their writes sit beside a non-zero exit. */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'src')

type Allowed = { file: string; write: string; reason: string }

/** Error writes beside a non-zero exit that are deliberately not a `token-goat:` line, each matched on its file and a fragment of the write's own text. */
const ALLOWED: readonly Allowed[] = [
  {
    file: 'src/bash_runner.ts',
    write: '`[token-goat: ${displaySafeText(result.error.message)}]\\n`',
    reason: "`token-goat run`'s passthrough path reporting that the wrapped command could not be spawned. It speaks inside the wrapped command's own stderr stream, in the bracketed marker shape the captured path appends for the same failure (and for its timeout and capture-cap notes), so both paths of the runner report a spawn failure identically to the agent reading that command's output.",
  },
]

type Report = { file: string; exit: string; reason: string }

/** Conditional exits whose stdout prose is the command's answer rather than the reason it failed, each matched on its file and the exit statement's text. */
const REPORTS: readonly Report[] = [
  {
    file: 'src/read_structured_data.ts',
    exit: 'return isClean ? 0 : 1',
    reason: "html-lint is a linter: its stdout is the list of findings and exit 1 says that list is not clean, the contract eslint and tsc keep, so a script reads the findings in the same place on every run and the exit code alone tells it whether to stop.",
  },
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function isStderrWrite(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === 'emitErr' || callee.text === 'err'
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.getText()
    return name === 'process.stderr.write' || name === 'console.error'
  }
  return false
}

function isStdoutWrite(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === 'out' || callee.text === 'emit' || callee.text === 'emitGuarded'
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.getText()
    return name === 'process.stdout.write' || name === 'console.log'
  }
  return false
}

/** The writes one statement makes to the sink `isWrite` names (stderr unless told otherwise), or null when it is not purely a write: a bare write, an if/else whose every branch is one write, or a for-of whose body is one write. */
function writesOf(stmt: ts.Statement, isWrite: (node: ts.Node) => node is ts.CallExpression = isStderrWrite): ts.CallExpression[] | null {
  if (ts.isExpressionStatement(stmt)) return isWrite(stmt.expression) ? [stmt.expression] : null
  const single = (s: ts.Statement): ts.Statement | null => (ts.isBlock(s) ? (s.statements.length === 1 ? s.statements[0]! : null) : s)
  if (ts.isIfStatement(stmt)) {
    const calls: ts.CallExpression[] = []
    for (const branch of [stmt.thenStatement, stmt.elseStatement]) {
      if (branch === undefined) continue
      const inner = single(branch)
      const w = inner === null ? null : writesOf(inner, isWrite)
      if (w === null) return null
      calls.push(...w)
    }
    return calls
  }
  if (ts.isForOfStatement(stmt)) {
    // A loop body may name a value before writing it (`const closes = ...` then `if (closes.length > 0) emitErr(...)`); a declaration prints nothing, so only the other statements decide whether the loop is part of the run.
    const body = ts.isBlock(stmt.statement) ? stmt.statement.statements.filter((s) => !ts.isVariableStatement(s)) : [stmt.statement]
    const calls: ts.CallExpression[] = []
    for (const s of body) {
      const w = writesOf(s, isWrite)
      if (w === null) return null
      calls.push(...w)
    }
    return body.length === 0 ? null : calls
  }
  return null
}

/** The writes one statement makes to either sink, where an if/else may split them (stdout on success, stderr on failure): each branch is one write to some sink. */
function sinkWritesOf(stmt: ts.Statement): { stdout: ts.CallExpression[]; stderr: ts.CallExpression[] } {
  const anyWrite = (node: ts.Node): node is ts.CallExpression => isStdoutWrite(node) || isStderrWrite(node)
  const calls = writesOf(stmt, anyWrite) ?? []
  return { stdout: calls.filter((c) => isStdoutWrite(c)), stderr: calls.filter((c) => isStderrWrite(c)) }
}

/** A `<cond> ? 0 : N` exit code, either branch order, N a non-zero literal: a failure on one branch and a success on the other. */
function isConditionalExitCode(e: ts.Expression | undefined): boolean {
  while (e !== undefined && ts.isParenthesizedExpression(e)) e = e.expression
  if (e === undefined || !ts.isConditionalExpression(e)) return false
  const zero = (x: ts.Expression): boolean => ts.isNumericLiteral(x) && x.text === '0'
  return (zero(e.whenTrue) && nonZeroLiteral(e.whenFalse)) || (nonZeroLiteral(e.whenTrue) && zero(e.whenFalse))
}

function conditionalExit(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt)) return isConditionalExitCode(stmt.expression)
  if (!ts.isExpressionStatement(stmt)) return false
  const e = stmt.expression
  return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && e.left.getText() === 'process.exitCode' && isConditionalExitCode(e.right)
}

const JSON_RENDER = /^(?:displaySafeJson|JSON\.stringify)\(/

/** Whether a stdout write's argument is a JSON rendering, directly or through a `const` the same statement list initialised with one: a --json body is the answer a failure still owes its caller on stdout. */
function writesJson(call: ts.CallExpression, stmts: ts.NodeArray<ts.Statement>, before: number): boolean {
  const arg = call.arguments[0]
  if (arg === undefined) return false
  if (JSON_RENDER.test(arg.getText())) return true
  if (!ts.isIdentifier(arg)) return false
  for (let j = before - 1; j >= 0; j--) {
    const s = stmts[j]!
    if (!ts.isVariableStatement(s)) continue
    for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === arg.text) return d.initializer !== undefined && JSON_RENDER.test(d.initializer.getText())
    }
  }
  return false
}

const nonZeroLiteral = (e: ts.Expression | undefined): boolean => e !== undefined && ts.isNumericLiteral(e) && e.text !== '0'

/** 'after' when an error write may also follow this exit (an exitCode assignment, which does not leave the block); 'before' for an exit that does; null when the statement is no non-zero exit. */
function exitKind(stmt: ts.Statement): 'before' | 'after' | null {
  if (ts.isReturnStatement(stmt)) {
    const e = stmt.expression
    return nonZeroLiteral(e) || e?.kind === ts.SyntaxKind.NullKeyword ? 'before' : null
  }
  if (ts.isThrowStatement(stmt)) return 'before'
  if (!ts.isExpressionStatement(stmt)) return null
  const e = stmt.expression
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && e.left.getText() === 'process.exitCode' && nonZeroLiteral(e.right)) return 'after'
  if (ts.isCallExpression(e) && e.expression.getText() === 'process.exit' && nonZeroLiteral(e.arguments[0])) return 'before'
  return null
}

const ROUTED = /\b(?:formatCommandError|formatFailedResultText|formatGitFailure)\(/

type Site = { file: string; line: number; write: string }

/** A conditional exit with stdout writes above it in its statement list: `prose` when one of them is not a JSON rendering, `stderr` when the list also writes to stderr. */
type ConditionalSite = { file: string; line: number; exit: string; prose: boolean; stderr: boolean }

function scan(): { errorWrites: Site[]; textWrites: Site[]; conditionalExits: ConditionalSite[] } {
  const errorWrites: Site[] = []
  const textWrites: Site[] = []
  const conditionalExits: ConditionalSite[] = []
  for (const abs of sourceFiles(SRC)) {
    const file = path.relative(ROOT, abs).split(path.sep).join('/')
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true)
    const site = (call: ts.CallExpression): Site => ({ file, line: sf.getLineAndCharacterOfPosition(call.getStart()).line + 1, write: call.arguments.map((a) => a.getText()).join(', ') })
    const visit = (node: ts.Node): void => {
      // The two stderr sinks themselves (cli.ts `err`, emit.ts `emitErr`): their `text` parameter is whatever the caller already formatted.
      if (ts.isFunctionDeclaration(node) && (node.name?.text === 'err' || node.name?.text === 'emitErr')) return
      if (isStderrWrite(node) && node.arguments.length >= 1) {
        // A result's text written bare, or passed through one wrapper call (`f(text)`, `f(text) + '\n'`): the population is both, so a routed site still counts toward the floor.
        const isText = (e: ts.Expression): boolean => (ts.isIdentifier(e) && e.text === 'text') || (ts.isPropertyAccessExpression(e) && e.name.text === 'text')
        let arg = node.arguments[0]!
        if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) arg = arg.left
        if (isText(arg) || (ts.isCallExpression(arg) && arg.arguments.length === 1 && isText(arg.arguments[0]!))) textWrites.push(site(node))
      }
      const stmts = ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node) ? node.statements : null
      if (stmts !== null) {
        for (let i = 0; i < stmts.length; i++) {
          if (conditionalExit(stmts[i]!)) {
            let anyStdout = false
            let prose = false
            let stderr = false
            for (let j = 0; j < i; j++) {
              const w = sinkWritesOf(stmts[j]!)
              if (w.stdout.length > 0) anyStdout = true
              if (w.stdout.some((c) => !writesJson(c, stmts, j))) prose = true
              if (w.stderr.length > 0) stderr = true
            }
            if (anyStdout) conditionalExits.push({ file, line: sf.getLineAndCharacterOfPosition(stmts[i]!.getStart()).line + 1, exit: stmts[i]!.getText(), prose, stderr })
          }
          const kind = exitKind(stmts[i]!)
          if (kind === null) continue
          let first: ts.CallExpression[] | null = null
          for (let j = i - 1; j >= 0; j--) {
            const w = writesOf(stmts[j]!)
            if (w === null || w.length === 0) break
            first = w
          }
          if (first === null && kind === 'after') {
            const w = i + 1 < stmts.length ? writesOf(stmts[i + 1]!) : null
            if (w !== null && w.length > 0) first = w
          }
          for (const call of first ?? []) errorWrites.push(site(call))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { errorWrites, textWrites, conditionalExits }
}

const { errorWrites, textWrites, conditionalExits } = scan()
const label = (s: Site): string => `${s.file}:${s.line} ${s.write.replace(/\s+/g, ' ').slice(0, 140)}`
const allowedFor = (s: Site): Allowed | undefined => ALLOWED.find((a) => a.file === s.file && s.write.includes(a.write))
const conditionalLabel = (s: ConditionalSite): string => `${s.file}:${s.line} ${s.exit}`
const reportFor = (s: ConditionalSite): Report | undefined => REPORTS.find((r) => r.file === s.file && s.prose && s.exit === r.exit)

describe('command errors carry the token-goat prefix', () => {
  it('opens every error written beside a non-zero exit with formatCommandError', () => {
    pinnedPopulation({
      what: 'first stderr writes beside a non-zero exit in src/',
      items: errorWrites.map(label),
      floor: 150,
      ceiling: 185,
      mustInclude: ['src/cli_dispatch.ts', 'src/read_structured_data.ts', 'src/read_inspect.ts', 'src/session_store_schema.ts', 'src/cli_upgrade.ts', 'src/bash_runner.ts'],
    })
    const offenders = errorWrites.filter((s) => !ROUTED.test(s.write) && allowedFor(s) === undefined).map(label)
    expect(offenders, 'route these through formatCommandError (src/command_error.ts), or add an ALLOWED entry saying why the line is not a token-goat error').toEqual([])
  })

  it('writes a failed { text, code } result to stderr through formatFailedResultText', () => {
    pinnedPopulation({
      what: '{ text, code } texts written to stderr in src/',
      items: textWrites.map(label),
      floor: 6,
      ceiling: 12,
      mustInclude: ['src/cli_dispatch.ts', 'src/read_brief.ts', 'src/session_store_schema.ts', 'src/cli.ts'],
    })
    const offenders = textWrites.filter((s) => !ROUTED.test(s.write)).map(label)
    expect(offenders).toEqual([])
  })

  it('writes the reason a conditional exit fails to stderr, never only as stdout prose', () => {
    pinnedPopulation({
      what: 'conditional exits with a stdout write above them in src/',
      items: conditionalExits.map(conditionalLabel),
      floor: 3,
      ceiling: 8,
      mustInclude: ['src/read_refs.ts', 'src/read_structured_data.ts', 'src/cli_install.ts'],
    })
    const offenders = conditionalExits.filter((s) => s.prose && !s.stderr && reportFor(s) === undefined).map(conditionalLabel)
    expect(offenders, 'on the failing branch write the reason to stderr through formatCommandError (or writeCommandFailure), keeping only a --json body on stdout; or add a REPORTS entry saying why the stdout text is the answer').toEqual([])
  })

  it('keeps every ALLOWED and REPORTS entry matched to a live site', () => {
    for (const a of ALLOWED) {
      expect(errorWrites.some((s) => allowedFor(s) === a), `ALLOWED entry for ${a.file} matches no error write any more; delete it`).toBe(true)
      expect(a.reason.length).toBeGreaterThan(40)
    }
    for (const r of REPORTS) {
      expect(conditionalExits.some((s) => s.prose && reportFor(s) === r), `REPORTS entry for ${r.file} matches no conditional exit after stdout prose any more; delete it`).toBe(true)
      expect(r.reason.length).toBeGreaterThan(40)
    }
  })
})

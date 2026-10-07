/** Every deny and hint template token-goat builds around an ordinary path must come out of the suggestion guard byte-identical. stripUnsafeSuggestions (src/hint_suggestion_guard.ts) runs on every hook's output in relayInProcess and replaces any `token-goat …` suggestion holding a character outside its allowlist between quoted arguments. The edit-anyway hint appended to every large-file and re-read deny wrote `--old-b64 <base64> --new-b64 <base64>` with bare angle-bracket placeholders, which the allowlist refuses as redirection, so on a plain path the model got "To edit it anyway, use `token-goat (command omitted: the path contains shell metacharacters)` to rewrite the whole file" and lost both edit commands. A template that trips the guard on a clean path is a template bug, not a path the guard caught. PROVENANCE: the paths are HAND-DERIVED ordinary repository paths with no shell metacharacter; the "before" text is CAPTURE from relayInProcess against the pre-fix source (2026-10-04). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { sqlTableHint, surgicalHintFor, surgicalHintForConfigDoc, sedOverlapHint, sedRangeHint, buildRecallHint } from '../../src/bash_extractors.js'
import { bodyFoldNotice, commentFoldNotice } from '../../src/fold_delivery.js'
import { docSectionHint, grepLinesHint, leadWithCommand, stripUnsafeSuggestions } from '../../src/hint_suggestion_guard.js'
import { fileQueryHint, hintTarget, sliceForPath } from '../../src/hint_target.js'
import { buildPackageManifestHint } from '../../src/hints.js'
import { handlePdf, handlePptx, handleXlsx } from '../../src/hints/file_type_handler.js'
import { editAnywayHint, truncatedReadDenyMessage } from '../../src/hooks_read_slice.js'
import { realSymbolReadHint } from '../../src/hooks_read.js'
import { relayInProcess } from '../../src/relay.js'

import { pinnedPopulation } from './population.js'

const PLAIN_PATHS = ['src/parser.ts', 'docs/guide.md', 'config/app.json', 'db/schema.sql', 'C:/Projects/app/src/main.py', '.env']

const SUB = { requestedBytes: 4000, replacementBytes: 900, commands: ['token-goat read "src/parser.ts::parseFile"', 'token-goat section "docs/guide.md::Install"'] }

/** Each template, called the way its hook calls it, with an ordinary path. */
function templates(p: string): Array<[string, string]> {
  const target = hintTarget(p, sliceForPath(p))
  const out: Array<[string, string]> = [
    ['editAnywayHint', editAnywayHint(p)],
    ['truncatedReadDenyMessage', truncatedReadDenyMessage(p)],
    ['realSymbolReadHint', realSymbolReadHint(p, p)],
    ['fileQueryHint', fileQueryHint(p, 'Read loads the whole file.')],
    ['docSectionHint', docSectionHint(p, 'Install', 'Read loads the whole file.')],
    ['grepLinesHint', grepLinesHint('<pattern>', p, 'Read loads the whole file.')],
    ['leadWithCommand', leadWithCommand('token-goat skeleton "' + p + '"', 'for structure', '`cat` loads the entire file into context.')],
    ['sqlTableHint', sqlTableHint(p, target, 'cat loads it all.')],
    ['surgicalHintForConfigDoc', surgicalHintForConfigDoc(p, true, true, true, true, target, 'cat loads it all.')],
    ['sedOverlapHint', sedOverlapHint(p, [1, 40], 20, 80)],
    ['sedRangeHint', sedRangeHint(p, [[1, 40]], 'sed', SUB)],
    ['bodyFoldNotice', bodyFoldNotice('parseFile', 10, 40, p, 9)],
    ['commentFoldNotice', commentFoldNotice(3, 14, p)],
    ['buildRecallHint', buildRecallHint('npx tsc --noEmit', 'ab12cd')],
    ['handlePdf', handlePdf(p, 4096).message],
    ['handleXlsx', handleXlsx(p).message],
    ['handlePptx', handlePptx(p).message],
  ]
  for (const env of [false, true]) for (const config of [false, true]) for (const doc of [false, true]) for (const xml of [false, true]) {
    out.push(['surgicalHintFor ' + [env, config, doc, xml].join('/'), surgicalHintFor(p, env, config, doc, xml, target, 'cat loads it all.')])
  }
  const manifest = buildPackageManifestHint({ file_path: path.join(path.dirname(p), 'package.json'), shown: path.join(path.dirname(p), 'package.json') })
  if (manifest !== null) out.push(['buildPackageManifestHint', manifest.text])
  return out
}

describe('deny and hint templates around an ordinary path', () => {
  it.each(PLAIN_PATHS)('pass the suggestion guard unchanged for %s', (p) => {
    const built = templates(p)
    // A template list that stopped producing suggestions would pass vacuously.
    expect(built.filter(([, text]) => text.includes('token-goat ')).length).toBeGreaterThanOrEqual(14)
    for (const [name, text] of built) {
      expect(stripUnsafeSuggestions(text), name + ' was rewritten by the guard').toBe(text)
    }
  })
})

describe('the large-file deny through the relay', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-edit-anyway-'))
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"edit-anyway"}\n')
    fs.writeFileSync(path.join(dir, 'big.ts'), 'export const filler = 1\n'.repeat(60_000))
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('still names both edit commands', async () => {
    const file = path.join(dir, 'big.ts')
    const wire = await relayInProcess('pre_tool_use', { session_id: 'edit-anyway-guard', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file } })
    const parsed = JSON.parse(wire) as { reason?: string; hookSpecificOutput?: { permissionDecisionReason?: string } }
    const reason = parsed.reason ?? parsed.hookSpecificOutput?.permissionDecisionReason ?? ''
    expect(reason, 'the read was not denied, so this case proves nothing').toContain('is very large')
    expect(reason).not.toContain('command omitted')
    expect(reason).toContain('token-goat replace "')
    expect(reason).toContain('token-goat write-file "')
    expect(reason).toContain('--old-b64 "<base64>"')
  })
})

describe('the paging note through the relay, for a file under a directory holding a space', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-spaced-hint-'))
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"spaced-hint"}\n')
    fs.mkdirSync(path.join(dir, 'my proj', 'src dir'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'my proj', 'src dir', 'big file.ts'), Array.from({ length: 400 }, (_, i) => 'export const v' + i + ' = ' + i).join('\n') + '\n')
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  // CAPTURE: a ranged Read's tool_response { type: 'text', file: { filePath, content, numLines, startLine, totalLines } }, the envelope tests/code_fold.test.ts's `rangedEvent` documents from 798 ranged Read results in real Claude Code transcripts. The windows are HAND-DERIVED: the third sequential 100-line page draws the soft paging note, the fourth the paging deny.
  it('names skeleton with the path in one double-quoted argument, in the note and in the deny', async () => {
    const file = path.join(dir, 'my proj', 'src dir', 'big file.ts')
    const base = { session_id: 'spaced-paging-guard', cwd: dir, tool_name: 'Read' }
    const contexts: string[] = []
    for (const offset of [1, 101, 201, 301]) {
      const tool_input = { file_path: file, offset, limit: 100 }
      const wire = await relayInProcess('pre_tool_use', { ...base, hook_event_name: 'PreToolUse', tool_input })
      const parsed = JSON.parse(wire || '{}') as { reason?: string; hookSpecificOutput?: { permissionDecisionReason?: string; additionalContext?: string } }
      contexts.push(parsed.reason ?? parsed.hookSpecificOutput?.permissionDecisionReason ?? parsed.hookSpecificOutput?.additionalContext ?? '')
      await relayInProcess('post_tool_use', { ...base, hook_event_name: 'PostToolUse', tool_input, tool_response: { type: 'text', file: { filePath: file, content: 'x', numLines: 100, startLine: offset, totalLines: 400 } } })
    }
    const [note, deny] = contexts.slice(2)
    expect(note, 'the third page drew no paging note, so this case proves nothing').toContain('Sequential line-range paging detected (3 slices read)')
    expect(deny, 'the fourth page drew no paging deny, so this case proves nothing').toContain('Sequential line-range paging detected on ')
    for (const text of [note, deny]) {
      expect(text).not.toContain('command omitted')
      expect(text).toMatch(/`token-goat skeleton "[^"`]*my proj\/src dir\/big file\.ts"`/)
    }
  })
})

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** Stands in for every interpolated value when a template is read off the source: an ordinary path, so a rewrite can only come from the template's own text. */
const PLAIN = 'src/a.ts'

/** Source files whose `token-goat …` strings are printed by the CLI, the MCP server or an installer and never pass through relayInProcess, so the hook-side guard never sees them. A hook module (hooks_*, hook_*, hints/, relay) can never be listed. */
const NOT_RELAYED: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'bridges/copilot_cli.ts', reason: 'the generated shim script body, run by Copilot CLI, not model-facing text' },
  { file: 'bridges/neovim_install.ts', reason: 'Lua source written into the Neovim plugin, which shell-escapes its own arguments' },
  { file: 'bridges/opencode.ts', reason: 'the generated opencode plugin source' },
  { file: 'bridges/relay_block.ts', reason: 'a code comment inside a generated bridge script' },
  { file: 'bridges/shrink_block.ts', reason: 'a code comment inside a generated bridge script' },
  { file: 'bridges_status.ts', reason: 'evidence text shown by `doctor` and `bridges`' },
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const isConcat = (n: ts.Node): n is ts.BinaryExpression => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken

/** The helpers that put one argument of a suggested command in quotes: quotedArg (src/hint_suggestion_guard.ts) always, answer_router.ts's viaArg whenever the value holds whitespace or shell syntax, which every stand-in below that tests quoting does, and hooks_skill.ts's skillSectionArg, which quotes a real heading and otherwise writes the `"<heading>"` placeholder. */
const QUOTING_HELPERS = new Set(['quotedArg', 'viaArg', 'skillSectionArg'])

const isQuotingCall = (n: ts.Node): boolean => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && QUOTING_HELPERS.has(n.expression.text)

/** quotedArgs (src/hint_suggestion_guard.ts), which quotes every argument of one command with one mark and returns them as an array. */
const isQuotedArgsCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'quotedArgs'

/** The argument count of a `quotedArgs(…).join(' ')`, which lands in a template as that many quoted values separated by spaces, or null for any other expression. */
function quotedArgsJoinCount(n: ts.Node): number | null {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'join') return null
  const sep = n.arguments[0]
  if (!isQuotedArgsCall(n.expression.expression) || sep === undefined || !ts.isStringLiteral(sep) || sep.text !== ' ') return null
  return n.expression.expression.arguments.length
}

/** Whether `id` names a const that a quoting helper initialised in a block or file enclosing it (hooks_skill.ts's `nameArg`), or one element of an array a quotedArgs call initialised (`const [quoted, b64] = quotedArgs(…)`), so it reads as quoted just like the call. */
function quotedConst(id: ts.Identifier): boolean {
  for (let scope: ts.Node | undefined = id.parent; scope !== undefined; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue
    for (const st of scope.statements) {
      if (!ts.isVariableStatement(st) || (st.declarationList.flags & ts.NodeFlags.Const) === 0) continue
      if (st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === id.text && d.initializer !== undefined && isQuotingCall(d.initializer))) return true
      if (st.declarationList.declarations.some((d) => ts.isArrayBindingPattern(d.name) && d.initializer !== undefined && isQuotedArgsCall(d.initializer) && d.name.elements.some((e) => ts.isBindingElement(e) && ts.isIdentifier(e.name) && e.name.text === id.text))) return true
    }
  }
  return false
}

/** How an interpolated value is written into a flattened template: one fixed stand-in, or a function of the expression (the bare-argument check below gives each one its own marker). */
type StandIn = string | ((expr: ts.Expression) => string)

/** The most texts one template expands to; past it, later combinations of its conditional branches go unchecked. */
const MAX_VARIANTS = 32

function cross(left: string[], right: string[]): string[] {
  return left.flatMap((l) => right.map((r) => l + r)).slice(0, MAX_VARIANTS)
}

/** A string expression's texts, one per combination of its conditional branches, so each branch is checked in the sentence it lands in. An interpolated value becomes `standIn`, a value passed through a quoting helper (or held in a const one initialised, or joined out of a quotedArgs call) becomes the stand-in in double quotes, and a command passed through fencedCommand (src/hint_suggestion_guard.ts) becomes its own flattened text in backticks, so the sentence around a fenced command is checked with the command in it rather than with a bare stand-in. */
function flatten(node: ts.Expression, standIn: StandIn = PLAIN): string[] {
  if (ts.isParenthesizedExpression(node)) return flatten(node.expression, standIn)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isTemplateExpression(node)) return node.templateSpans.reduce((acc, s) => cross(cross(acc, flatten(s.expression, standIn)), [s.literal.text]), [node.head.text])
  if (isConcat(node)) return cross(flatten(node.left, standIn), flatten(node.right, standIn))
  if (ts.isConditionalExpression(node)) return [...flatten(node.whenTrue, standIn), ...flatten(node.whenFalse, standIn)].slice(0, MAX_VARIANTS)
  if (isQuotingCall(node) || (ts.isIdentifier(node) && quotedConst(node))) return ['"' + (typeof standIn === 'string' ? standIn : PLAIN) + '"']
  const joined = quotedArgsJoinCount(node)
  if (joined !== null) return [Array.from({ length: joined }, () => '"' + (typeof standIn === 'string' ? standIn : PLAIN) + '"').join(' ')]
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fencedCommand' && node.arguments.length === 1) return flatten(node.arguments[0] as ts.Expression, standIn).map((t) => '`' + t + '`')
  return [typeof standIn === 'string' ? standIn : standIn(node)]
}

/** Every outermost string expression (literal, template, or `+` chain) in src naming `needle` (`token-goat ` unless given), flattened around `standIn`, one entry per distinct text it expands to. A file is skipped unless its source names `needle` too, except for a `"` needle, which a quoting helper writes into a template whose source holds none. */
function stringTemplates(standIn: StandIn, needle = 'token-goat '): Array<{ file: string; line: number; text: string }> {
  return sourceFiles(SRC).flatMap((abs) => {
    const source = fs.readFileSync(abs, 'utf8')
    return needle === '"' || source.includes(needle) ? templatesIn(path.relative(SRC, abs).split(path.sep).join('/'), source, standIn, needle) : []
  })
}

/** The outermost string expressions of one source file naming `needle`, as {@link stringTemplates} reads them. */
function templatesIn(file: string, source: string, standIn: StandIn, needle = 'token-goat '): Array<{ file: string; line: number; text: string }> {
  const found: Array<{ file: string; line: number; text: string }> = []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || isConcat(node)) {
      let parent = node.parent
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent
      if (!isConcat(parent)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
        for (const text of new Set(flatten(node as ts.Expression, standIn))) if (text.includes(needle)) found.push({ file, line, text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** Every outermost string expression (literal, template, or `+` chain) in src that names a `token-goat …` command with a double-quoted argument, keyed `file::text`. */
function suggestionTemplates(): Array<{ file: string; line: number; text: string }> {
  return stringTemplates(PLAIN).filter((t) => t.text.includes('"'))
}

describe('every suggestion template in src', () => {
  const all = suggestionTemplates()
  const notRelayed = new Set(NOT_RELAYED.map((e) => e.file))

  it('is scanned', () => {
    pinnedPopulation({
      what: 'token-goat suggestion templates with a quoted argument in src',
      items: all.map((t) => t.file + '::' + t.text),
      floor: 220,
      mustInclude: ['hooks_read_slice.ts::To edit it anyway', 'hooks_read.ts::This file was already read this session. Tool output spill files', 'hooks_bash.ts::token-goat available for this file type', 'hints/file_type_handler.ts::Then extract relevant pages'],
    })
  })

  it('passes the suggestion guard unchanged around an ordinary path, unless its file never reaches a hook', () => {
    const rewritten = all.filter((t) => !notRelayed.has(t.file) && stripUnsafeSuggestions(t.text) !== t.text)
    expect(rewritten.map((t) => t.file + ':' + t.line + ' ' + t.text.slice(0, 160) + '\n  -> ' + stripUnsafeSuggestions(t.text).slice(0, 160))).toEqual([])
  })

  it('exempts no hook module and no file that has nothing left to exempt', () => {
    for (const { file } of NOT_RELAYED) {
      expect(/^(hooks?_|hints\/|relay)/.test(file), file + ' is a hook module').toBe(false)
      expect(all.some((t) => t.file === file && stripUnsafeSuggestions(t.text) !== t.text), file + ' no longer has a template the guard rewrites; drop it from NOT_RELAYED').toBe(true)
    }
  })
})

/** Stands in for every interpolated value when the path argument's quoting is under test: a path holding a space, which a bare suggestion splits into two arguments. `token-goat scope my proj/a.ts:12` exited 1 with "too many arguments for 'scope'" and `token-goat skeleton my proj/a.ts` with "Could not read: my". PROVENANCE: HAND-DERIVED path; the failures are CAPTURE from the installed 2.9.30 binary against `C:/tgdog-pass2/d12/my proj` (2026-10-05). */
const SPACED = 'src/a b.ts'

/** Commands whose first positional argument is a file path (grep's comes after its quoted pattern). symbol is absent: it takes a name. */
const PATH_FIRST = new Set(['read', 'section', 'skeleton', 'outline', 'grep', 'scope', 'yaml-outline', 'yaml-query', 'xml-outline', 'xml-query', 'json-outline', 'json-query', 'toml-outline', 'config-get', 'deps', 'exports', 'imports', 'test-for', 'zip-list', 'openapi-outline', 'brief', 'refs', 'impact', 'callers', 'file-summary', 'pdf-meta', 'pdf-outline', 'pdf-locate', 'pdf-extract', 'docx-outline', 'docx-tables', 'docx-text', 'pptx-outline', 'pptx-slide', 'pptx-notes', 'pptx-text', 'xlsx-sheets', 'xlsx-columns', 'xlsx-head', 'xlsx-range', 'xlsx-query', 'image-meta', 'image-text', 'csv-query', 'sqlite-query'])

/** Each path-first command in `text` whose path argument is the interpolated stand-in, quoted or not, cut from the command name to a little past the argument, and whether that argument is bare. */
function pathSlots(text: string): Array<{ slot: string; bare: boolean }> {
  const slots: Array<{ slot: string; bare: boolean }> = []
  for (const m of text.matchAll(/token-goat ([a-z][a-z-]*) /g)) {
    if (!PATH_FIRST.has(m[1] ?? '')) continue
    let rest = text.slice((m.index ?? 0) + m[0].length)
    if (m[1] === 'grep') {
      const pattern = /^"[^"]*" /.exec(rest)
      if (!pattern) continue
      rest = rest.slice(pattern[0].length)
    }
    if (rest.startsWith(SPACED) || rest.startsWith('"' + SPACED + '"')) slots.push({ slot: m[0] + rest.slice(0, 60), bare: rest.startsWith(SPACED) })
  }
  return slots
}

describe('the path argument of every suggested command in src', () => {
  const slots = stringTemplates(SPACED).flatMap((t) => pathSlots(t.text).map(({ slot, bare }) => ({ where: t.file + ':' + t.line, key: t.file + '::' + slot, bare })))

  it('is scanned', () => {
    pinnedPopulation({
      what: 'path arguments of suggested token-goat commands in src',
      items: slots.map((s) => s.key),
      floor: 115,
      mustInclude: ['hooks_read.ts::token-goat scope "' + SPACED, 'hooks_read.ts::token-goat skeleton "' + SPACED, 'read_commands.ts::token-goat yaml-outline "' + SPACED, 'answer_router.ts::token-goat test-for "' + SPACED],
    })
  })

  it('is double-quoted, so a path holding a space stays one argument', () => {
    expect(slots.filter((s) => s.bare).map((s) => s.where + ' ' + s.key)).toEqual([])
  })
})

describe('the key argument of every suggested config-get in src', () => {
  // HAND-DERIVED: the key slot followed the quoted path bare (`config-get ".env" PORT`), outside the quotes the relay checks; configGetCommand (src/hint_suggestion_guard.ts) quotes it, and every site goes through that one helper.
  const lead = 'token-goat config-get "' + SPACED + '" '
  const keySlots = stringTemplates(SPACED).flatMap((t) => t.text.split(lead).slice(1).map((after) => ({ where: t.file + ':' + t.line, key: t.file + '::' + lead + after.slice(0, 20), quoted: after.startsWith('"') })))

  it('is scanned', () => {
    pinnedPopulation({ what: 'key arguments of suggested config-get commands in src', items: keySlots.map((s) => s.key), floor: 1, ceiling: 1, mustInclude: ['hint_suggestion_guard.ts::' + lead] })
  })

  it('is double-quoted and built by configGetCommand alone', () => {
    expect(keySlots.filter((s) => !s.quoted || !s.where.startsWith('hint_suggestion_guard.ts:')).map((s) => s.where + ' ' + s.key)).toEqual([])
  })
})

/** Brackets one interpolated value in a flattened template, so the check below can tell where each value landed and which expression put it there. Neither character occurs in a template's own text. */
const OPEN = '\u0001'
const CLOSE = '\u0002'

/** Every command name the CLI registers, read off its `.command('…')` calls, so a status line such as `token-goat shrank …` or `token-goat v2.9.30 -> v2.9.31` is not read as a command. */
function registeredCommands(): Set<string> {
  const names = new Set<string>()
  for (const abs of sourceFiles(SRC)) for (const m of fs.readFileSync(abs, 'utf8').matchAll(/\.command\('([a-z][a-z0-9-]*)/g)) names.add(m[1] ?? '')
  return names
}

/** Each interpolated value in a `token-goat <command>` of `text` that no quoting helper quoted: bare (a shell splits it at a space and expands what it holds), inside single quotes (which a value holding `'` closes), or inside double quotes the template wrote by hand (`"${p}"`, where a `$`, backtick or `"` in the value breaks the command; quotedArg single-quotes such a value), the command name slot included. A value a quoting helper put in quotes is flattened to the plain stand-in and never reaches here. A fenced command runs to its closing backtick, and a command wrapped whole in quotes to the closing quote, its values inside that quote. An unfenced one in a sentence stops at its first bare word, which is prose or a literal argument either way, and at a `.`, `,`, `;` or `)` that ends a clause. */
function unquotedValues(text: string, commands: ReadonlySet<string>): Array<{ marker: number; how: 'bare' | 'single-quoted' | 'hand-quoted' }> {
  const out: Array<{ marker: number; how: 'bare' | 'single-quoted' | 'hand-quoted' }> = []
  const markerAt = (i: number): { marker: number; end: number } => {
    const end = text.indexOf(CLOSE, i)
    return { marker: Number(text.slice(i + 1, end)), end: end + 1 }
  }
  for (const m of text.matchAll(new RegExp('token-goat (' + OPEN + '\\d+' + CLOSE + '|[a-z][a-z0-9-]*)', 'g'))) {
    const name = m[1] ?? ''
    if (name.startsWith(OPEN)) out.push({ marker: Number(name.slice(1, -1)), how: 'bare' })
    else if (!commands.has(name)) continue
    const start = m.index ?? 0
    const fenced = text[start - 1] === '`'
    const before = text[start - 1] ?? ''
    const wrap = before === "'" || before === '"' ? before : null
    let quote: string | null = wrap
    let wordStart = true
    for (let i = start + m[0].length; i < text.length;) {
      const c = text[i] ?? ''
      if (quote !== null) {
        if (c === '\n') break
        if (c === quote && wrap !== null) break
        if (c === quote) quote = null
        else if (c === OPEN) {
          const at = markerAt(i)
          out.push({ marker: at.marker, how: quote === "'" ? 'single-quoted' : 'hand-quoted' })
          i = at.end
          continue
        }
        i++
        continue
      }
      if (c === '`' || c === '\n') break
      if (!fenced && wordStart && /[A-Za-z<]/.test(c)) break
      if (!fenced && /[.,;)]/.test(c) && /^\s?$/.test(text[i + 1] ?? '')) break
      if (c === OPEN) {
        const at = markerAt(i)
        out.push({ marker: at.marker, how: 'bare' })
        i = at.end
        wordStart = false
        continue
      }
      if (c === '"' || c === "'") quote = c
      wordStart = c === ' '
      i++
    }
  }
  return out
}

/** Interpolated values a suggestion may leave bare, each keyed `file::expression` and reviewed: an id token-goat minted, a number, a flag or command name from a fixed set, or a command line that is executed rather than suggested and quotes itself. Anything not here is quoted with quotedArg. */
const SAFE_BARE: ReadonlyArray<{ key: string; reason: string }> = [
  ...['bash_extractors.ts::outputId', 'bash_runner.ts::id', 'cli_recall.ts::hit.id', 'content_store.ts::id', 'hooks_agent_spawn.ts::id', 'hooks_bash.ts::monOutputId', 'hooks_bash.ts::curlOutputId', 'hooks_bash.ts::ghOutputId', 'hooks_bash.ts::gitScopedOutputId', 'hooks_bash_post.ts::containerId', 'hooks_bash_post.ts::id', 'hooks_bash_post.ts::testFailId', 'hooks_fetch.ts::cacheId', 'hooks_fetch.ts::id', 'hooks_mcp.ts::id', 'hooks_read.ts::latestId', 'hooks_read.ts::alreadyServed.id', 'hooks_websearch.ts::id', 'served_lines.ts::id'].map((key) => ({ key, reason: 'a cache id token-goat minted from a hash, hex digits only' })),
  { key: 'answer_router.ts::ANSWER_DELEGATE_LIMIT', reason: 'a numeric constant' },
  { key: 'read_git.ts::suggestedRef', reason: '`HEAD~n` for a number n, or the fixed empty-tree hash' },
  { key: 'hooks_bash.ts::monitoringHint', reason: 'a flag string from the fixed MONITORING_COMMAND_PATTERNS table (src/hints/lang_patterns.ts)' },
  ...['answer_router.ts::command', 'answer_router.ts::cls.intent', 'bash_extractors.ts::fmt', 'hint_target.ts::format', 'hooks_read.ts::fmt', 'read_spec.ts::command', 'read_spec.ts::commandName', 'read_suggest.ts::command', 'read_symbol.ts::hit.command', 'cli_recall.ts::RECALL_COMMAND[hit.cacheType]', 'hooks_bash.ts::tgRead.sub'].map((key) => ({ key, reason: 'a command name (or `json`/`yaml` prefix) from a fixed set in the source, never user text' })),
  { key: 'cli_install.ts::leftover.flag', reason: 'an install flag such as `--codex` from the fixed leftoverIntegrations table' },
  ...['cli_install.ts::removal.label', 'cli_install.ts::leftover.label'].map((key) => ({ key, reason: 'a fixed integration label in a status line (`Removed token-goat Codex CLI integration.`), not a command' })),
  { key: 'content_store.ts::name', reason: 'a handoff name createHandoff refuses unless it matches /^[A-Za-z0-9._-]{1,128}$/' },
  ...['hooks_bash.ts::filterName', 'hooks_bash.ts::cfg.timeout_seconds', 'hooks_bash.ts::capArgs', 'hooks_bash.ts::shellQuoteSingle(rawCmd)'].map((key) => ({ key, reason: 'the compress wrapper command line the hook executes, built from a filter name, numbers and a shellQuoteSingle-quoted command' })),
  ...['bridges/antigravity_install.ts::eventArg', 'bridges/antigravity_install.ts::SHIM_MARKER', 'bridges/gemini_install.ts::eventArg', 'bridges/qwen_install.ts::eventArg'].map((key) => ({ key, reason: 'a hook command line written into the harness config, carrying a fixed event name and marker' })),
]

/** Values a template puts in double quotes by hand where the text is a probe, never shown: a candidate command handed to stripUnsafeSuggestions to ask whether the guard keeps it, whose name already refused every quote, `$` and backtick. Valid for a hand-quoted value only. */
const PROBE_HAND_QUOTED: ReadonlyArray<{ key: string; reason: string }> = [
  { key: 'hooks_read_policy.ts::trimmed', reason: 'safeSuggestionTarget() asks the guard about `token-goat read "test.ts::<name>"` after refusing quotes, `$` and backticks, and returns the name, never the probe' },
]

describe('every interpolated value in a suggested command in src', () => {
  const commands = registeredCommands()
  const scan = (templates: (standIn: StandIn) => Array<{ file: string; line: number; text: string }>): Array<{ where: string; key: string; how: string }> => {
    const exprs: string[] = []
    const mark = (expr: ts.Expression): string => {
      exprs.push(expr.getText().replace(/\s+/g, ' '))
      return OPEN + String(exprs.length - 1) + CLOSE
    }
    return templates(mark).flatMap((t) => unquotedValues(t.text, commands).map(({ marker, how }) => ({ where: t.file + ':' + t.line, key: t.file + '::' + exprs[marker], how })))
  }
  const found = scan(stringTemplates)
  const safe = new Set(SAFE_BARE.map((e) => e.key))
  const probes = new Set(PROBE_HAND_QUOTED.map((e) => e.key))

  it('is scanned', () => {
    expect(commands.size, 'the CLI command names were not found').toBeGreaterThan(100)
    pinnedPopulation({ what: 'interpolated values no quoting helper quoted in suggested token-goat commands in src', items: [...new Set(found.map((f) => f.key))], floor: 1, mustInclude: ['hooks_bash.ts::curlOutputId', 'answer_router.ts::ANSWER_DELEGATE_LIMIT', 'hooks_read_policy.ts::trimmed'] })
  })

  it('is quoted unless it is a reviewed safe value', () => {
    expect(found.filter((f) => !safe.has(f.key) && !(f.how === 'hand-quoted' && probes.has(f.key))).map((f) => f.where + ' ' + f.how + ' ' + f.key)).toEqual([])
  })

  it('lists no safe value that no longer appears', () => {
    expect(SAFE_BARE.filter((e) => !found.some((f) => f.key === e.key)).map((e) => e.key)).toEqual([])
    expect(PROBE_HAND_QUOTED.filter((e) => !found.some((f) => f.key === e.key && f.how === 'hand-quoted')).map((e) => e.key)).toEqual([])
  })

  // HAND-DERIVED virtual sources, one per shape the check has to tell apart: the symbol hint that suggested `token-goat symbol A|B` bare, a config-get key left outside the quotes its path is in, a branch of a conditional, a quoted const, a status line that only starts with the product name, a command named mid-sentence, and the compress hint that wrote `compress -c "${cmd}"` by hand (hooks_bash_post.ts).
  it('flags a bare value in any slot and passes a quoted one', () => {
    const virtual = (source: string): string[] => scan((standIn) => templatesIn('virtual.ts', source, standIn)).map((f) => f.how + ' ' + f.key.replace('virtual.ts::', ''))
    expect(virtual("const s = 'Use `token-goat symbol ' + identifier + '` to jump.'")).toEqual(['bare identifier'])
    expect(virtual("const s = 'Run `token-goat config-get ' + quotedArg(p) + ' ' + key + '`.'")).toEqual(['bare key'])
    expect(virtual("const s = flag ? 'Run `token-goat refs ' + quotedArg(n) + '`.' : 'Run `token-goat skill-body ' + n + '`.'")).toEqual(['bare n'])
    expect(virtual("function f(s) { const nameArg = quotedArg(s); return 'Run `token-goat skill-body ' + nameArg + ' --compact`.' }")).toEqual([])
    expect(virtual("const s = `Run 'token-goat session-schema ${table}' to inspect it.`")).toEqual(['single-quoted table'])
    expect(virtual("const s = 'token-goat shrank ' + subject + ': ' + kb + 'kb'")).toEqual([])
    expect(virtual("const s = 'Run token-goat worker start to ' + goal + '.'")).toEqual([])
    expect(virtual("const s = 'token-goat ' + sub + ' ' + quotedArg(p)")).toEqual(['bare sub'])
    expect(virtual("function f(n) { const [name, b64] = quotedArgs(n, '<base64>'); return 'Run `token-goat symbol ' + name + ' ' + b64 + '`.' }")).toEqual([])
    expect(virtual("function f(n) { const [name, b64] = splitArgs(n, '<base64>'); return 'Run `token-goat symbol ' + name + ' ' + b64 + '`.' }")).toEqual(['bare name', 'bare b64'])
    expect(virtual("const s = 'Run `token-goat config-get ' + quotedArgs(p, key).join(' ') + '`.'")).toEqual([])
    expect(virtual("const s = 'Run `token-goat config-get ' + splitArgs(p, key).join(' ') + '`.'")).toEqual(["bare splitArgs(p, key).join(' ')"])
    expect(virtual('const s = `Run \\`token-goat compress -c "${cmd}"\\` next time.`')).toEqual(['hand-quoted cmd'])
    expect(virtual('const s = `Run \\`token-goat compress -c ${quotedArg(cmd)}\\` next time.`')).toEqual([])
  })
})

/** A `--flag "` or `run "` slot in double quotes, written by hand or by a quoting helper (which flattens to the quoted plain stand-in). */
const QUOTED_SLOT = /(?:--[a-z][a-z0-9-]* |\b[Rr]un )"/g

/** Each interpolated value `text` puts in double quotes by hand as the value of a `--flag` or as a whole command after `run`, where a `$`, backtick or `"` in it breaks the command: `--section "${heading}#2"` (cli_cached_output.ts) and `Recovery: run "${install}"` (cli_doctor.ts) carry no `token-goat ` of their own for the scan above to start from. */
function handQuotedSlots(text: string): number[] {
  return [...text.matchAll(new RegExp(QUOTED_SLOT.source + OPEN + '(\\d+)' + CLOSE + '[^"\\n]*"', 'g'))].map((m) => Number(m[1]))
}

describe('every value hand-quoted as a flag value or a whole command in src', () => {
  const scan = (templates: (standIn: StandIn) => Array<{ file: string; line: number; text: string }>): string[] => {
    const exprs: string[] = []
    const mark = (expr: ts.Expression): string => {
      exprs.push(expr.getText().replace(/\s+/g, ' '))
      return OPEN + String(exprs.length - 1) + CLOSE
    }
    return templates(mark).flatMap((t) => handQuotedSlots(t.text).map((marker) => t.file + ':' + t.line + ' ' + exprs[marker]))
  }
  const slots = stringTemplates(PLAIN, '"').flatMap((t) => [...t.text.matchAll(QUOTED_SLOT)].map((m) => t.file + '::' + m[0] + t.text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + PLAIN.length + 1)))

  it('is scanned', () => {
    pinnedPopulation({ what: 'double-quoted --flag values and run commands in src string templates', items: [...new Set(slots)], floor: 2, mustInclude: ['cli_cached_output.ts::--section "' + PLAIN + '"', 'cli_file_ops.ts::--after "' + PLAIN + '"'] })
  })

  it('is quoted with quotedArg or fenced with fencedCommand', () => {
    expect(scan((standIn) => stringTemplates(standIn, '"'))).toEqual([])
  })

  // HAND-DERIVED virtual sources: the shapes src carried (cli_cached_output.ts `--section "${opts.section}#${i + 1}"`, cli_doctor.ts `run "${install}"`) beside their helper-quoted and fenced forms and a literal flag value.
  it('flags a hand-quoted flag value or run command and passes a quoted or fenced one', () => {
    const virtual = (source: string): string[] => scan((standIn) => templatesIn('virtual.ts', source, standIn, '"')).map((f) => f.replace('virtual.ts:1 ', ''))
    expect(virtual('const s = `line ${n} -> --section "${heading}#${i + 1}"`')).toEqual(['heading'])
    expect(virtual('const s = `Recovery: run "${install}", then restart.`')).toEqual(['install'])
    expect(virtual('const s = `line ${n} -> --section ${quotedArg(`${heading}#${i + 1}`)}`')).toEqual([])
    expect(virtual('const s = `Recovery: run ${fencedCommand(install)}, then restart.`')).toEqual([])
    expect(virtual('const s = `Run with --format "json" to get ${what}.`')).toEqual([])
  })
})

/** A heading echoed in quotes written by hand after the word section or heading: `Section '${heading}' not found` read `Section 'it's gone' not found` for a heading holding an apostrophe, beside retry forms quotedArg had already quoted. */
const HAND_QUOTED_HEADING = new RegExp('\\b(?:[Ss]ection|[Hh]eading) ([\'"])' + OPEN + '(\\d+)' + CLOSE + '[^\'"\\n]*\\1', 'g')

/** Each interpolated value `text` echoes as a heading in quotes written by hand. */
function handQuotedHeadings(text: string): number[] {
  return [...text.matchAll(HAND_QUOTED_HEADING)].map((m) => Number(m[2]))
}

describe('every heading echoed in an error or notice in src', () => {
  const scan = (templates: (standIn: StandIn) => Array<{ file: string; line: number; text: string }>): string[] => {
    const exprs: string[] = []
    const mark = (expr: ts.Expression): string => {
      exprs.push(expr.getText().replace(/\s+/g, ' '))
      return OPEN + String(exprs.length - 1) + CLOSE
    }
    return [...new Set(templates(mark).flatMap((t) => handQuotedHeadings(t.text).map((marker) => t.file + ':' + t.line + ' ' + exprs[marker])))]
  }
  const echoes = [...new Set(['ection ', 'eading '].flatMap((needle) => stringTemplates(PLAIN, needle)).filter((t) => /\b(?:[Ss]ection|[Hh]eading) "/.test(t.text)).map((t) => t.file))]

  it('is scanned', () => {
    pinnedPopulation({ what: 'src files echoing a quoted value after the word section or heading', items: echoes, floor: 5, mustInclude: ['read_section.ts', 'cli_file_ops.ts', 'cli_skills.ts', 'cli.ts', 'cli_cached_output.ts'] })
  })

  it('is quoted with quotedArg', () => {
    expect(scan((standIn) => [...stringTemplates(standIn, 'ection '), ...stringTemplates(standIn, 'eading ')])).toEqual([])
  })

  // HAND-DERIVED virtual sources: the shapes src carried (read_section.ts `Section '${heading}' not found in '${filePath}'`, cli_skills.ts `Section '${heading}' in skill`, read_section.ts `Ambiguous heading '${heading}' in`) beside a double-quoted hand form, the quotedArg form, and a heading word with no echo after it.
  it('flags a heading hand-quoted in either mark and passes a quotedArg one', () => {
    const virtual = (source: string): string[] => scan((standIn) => templatesIn('virtual.ts', source, standIn, 'ection ')).map((f) => f.replace('virtual.ts:1 ', ''))
    const virtualHeading = (source: string): string[] => scan((standIn) => templatesIn('virtual.ts', source, standIn, 'eading ')).map((f) => f.replace('virtual.ts:1 ', ''))
    expect(virtual("const s = `Section '${heading}' not found in '${filePath}'`")).toEqual(['heading'])
    expect(virtual('const s = `section "${opts.heading}" not found in document ${fileId}`')).toEqual(['opts.heading'])
    expect(virtualHeading("const s = `Ambiguous heading '${heading}' in ${quotedArg(file)}: `")).toEqual(['heading'])
    expect(virtual('const s = `Section ${quotedArg(heading)} not found in ${quotedArg(filePath)}`')).toEqual([])
    expect(virtual("const s = `the section 'Install' covers lines ${a}-${b}`")).toEqual([])
  })
})

/** Source files whose `'token-goat …'` or `"token-goat …"` text is code rather than a sentence: the quote is a delimiter of the generated script, Lua or SQL it sits in. */
const CODE_STRINGS: ReadonlyArray<{ file: string; reason: string }> = [
  ...['bridges/claudecode.ts', 'bridges/codex.ts', 'bridges/copilot_cli.ts', 'bridges/grok.ts', 'bridges/kimi.ts', 'bridges/pi.ts', 'bridges/relay_block.ts'].map((file) => ({ file, reason: 'the JavaScript source of a generated hook bridge script, whose string literals and comments build the hook command' })),
  { file: 'bridges/neovim_install.ts', reason: 'Lua source written into the Neovim plugin, whose string literals build the command it runs' },
  { file: 'db.ts', reason: 'SQL comments in the schema text' },
]

/** Each `token-goat <command>` in `text` set in quotes as a whole rather than in backticks: `Run 'token-goat doctor --repair' to fix it` reads the quotes as part of the command, the suggestion guard reads it as running on to the end of the line, and a value interpolated inside lands in single quotes. */
function quoteWrapped(text: string, commands: ReadonlySet<string>): string[] {
  return [...text.matchAll(/(["'])token-goat ([a-z][a-z0-9-]*)/g)].filter((m) => commands.has(m[2] ?? '')).map((m) => text.slice(m.index ?? 0, (m.index ?? 0) + 60).split('\n')[0] ?? '')
}

describe('every whole command named in a sentence in src', () => {
  const commands = registeredCommands()
  const code = new Set(CODE_STRINGS.map((e) => e.file))
  const wrapped = stringTemplates(PLAIN).flatMap((t) => quoteWrapped(t.text, commands).map((cmd) => ({ file: t.file, where: t.file + ':' + t.line, cmd })))

  it('is scanned', () => {
    pinnedPopulation({ what: 'token-goat commands set in quotes in src, code strings included', items: [...new Set(wrapped.map((w) => w.file + '::' + w.cmd))], floor: 9, mustInclude: ['bridges/neovim_install.ts::"token-goat symbol %s"', 'db.ts::' + "'token-goat recall'"] })
  })

  it('is fenced in backticks rather than wrapped in quotes', () => {
    expect(wrapped.filter((w) => !code.has(w.file)).map((w) => w.where + ' ' + w.cmd)).toEqual([])
  })

  it('exempts no file that has nothing left to exempt', () => {
    expect(CODE_STRINGS.filter((e) => !wrapped.some((w) => w.file === e.file)).map((e) => e.file)).toEqual([])
  })

  // HAND-DERIVED: the wrapped shapes src carried (cli_doctor.ts `Run 'token-goat doctor --repair' to ...`, cli_install.ts `Run "token-goat uninstall --vscode" to ...`) beside a fenced command, a status line and a quoted argument, none of which is a wrap.
  it('flags a command in single or double quotes and nothing else', () => {
    const virtual = (source: string): string[] => templatesIn('virtual.ts', source, PLAIN).flatMap((t) => quoteWrapped(t.text, commands))
    expect(virtual(`const s = "Run 'token-goat doctor --repair' to fix it."`)).toEqual(["'token-goat doctor --repair' to fix it."])
    expect(virtual("const s = 'Run \"token-goat uninstall --vscode\" to remove it.'")).toEqual(['"token-goat uninstall --vscode" to remove it.'])
    expect(virtual("const s = 'Run `token-goat doctor --repair` to fix it.'")).toEqual([])
    expect(virtual("const s = 'the \"token-goat shrank\" notice'")).toEqual([])
    expect(virtual("const s = 'Run `token-goat grep \"token-goat x\" src`.'")).toEqual([])
  })
})


/** A value interpolated between quotes written by hand: `Symbol '${symbol}' not found` read `Symbol 'it's' not found` for a name holding an apostrophe, and handed an indexed name's control characters on as written. echoedValue (src/hint_suggestion_guard.ts) escapes an echoed value and quotes it the way quotedArg quotes the retry commands beside it, and fencedCommand sets a whole command in backticks. */
const HAND_QUOTED_VALUE = new RegExp('([\'"])' + OPEN + '(\\d+)' + CLOSE + '[^\'"\\n]*\\1', 'g')

/** Why a hand-quoted interpolation below keeps its quotes. */
const R = {
  quoter: 'a quoting function: the quotes are what it exists to write, around a value it has escaped, or refused, for exactly those quotes',
  blank: 'blanks a quoted span to spaces of the same length so the command around it can be scanned; the quotes are the span\'s own',
  format: 'the quotes are the syntax of the format being written (CSV field, SQL identifier, FTS5 phrase, TOML string, HTML or XML attribute) and the value is escaped for that syntax in the same expression',
  sqlConst: 'SQL text around a table name or tokenizer token-goat fixes in a constant (DERIVED_TABLES, FTS_TOKENIZER)',
  generated: 'the source of a script or shim token-goat writes, around its own install paths or a fixed literal; never shown as a message',
  cmdLine: 'a command line handed to cmd.exe /s /c as one quoted string, each argument already quoted by windowsCmdQuoteArg',
  regex: 'a regex matching SQL\'s own double-quoted identifier syntax around a name escapeRegExp already escaped',
  jsonPath: 'json-query bracket-key syntax inside a path the caller then quotes whole with quotedArg; a name holding a single quote is refused first',
  sedRewrite: 'an internal rewrite into the `sed -n` form extractSedRange parses, never shown; a path holding a double quote is refused first',
  compressCmd: 'the cd prefix of the command `token-goat compress -c` re-runs, quoted whole with quotedArg; a directory holding a single quote drops the suggestion',
  duckdb: 'a SQL string literal inside a suggested duckdb query; sqlLiteralPath doubles any single quote in the path',
  pinned: 'a value read from the sha256-pinned tokenizer.json, named in an integrity failure in its own JSON syntax',
  render: 'a tool output line re-rendered in the tool\'s own syntax, which quotes the value the tool already printed in those quotes (Playwright aria snapshot, redis-cli key list)',
  number: 'a document number in the XML attribute syntax of a pack',
  base64: 'PowerShell or Python syntax around base64 text, which holds no quote mark (src/powershell_compat.ts, outside this pass\'s write scope)',
  jsonLeaf: 'a hint inside a --json payload that displaySafeJson escapes as a leaf string, so the value goes in as typed; escaping it here as well would escape it twice',
  mcpParam:'an MCP tool name and JSON parameter example, for a client with no shell: the value is one token-goat already quoted in its own retry command, the name is word characters, and a value holding a double quote or backtick is left out',
} as const

/** The hand-quoted interpolations that stay, each keyed `file::source line` (the line the interpolated value starts on, trimmed): the quotes belong to the syntax of what the text is, or hold a value token-goat fixes or pins. A key names one line, so a new hand-quoted value elsewhere in the same file is not covered by it, and an entry whose line changes or goes away fails until it is updated or removed. */
const QUOTES_ARE_SYNTAX: ReadonlyArray<{ key: string; reason: string }> = [
  ...[
    'bash_extractors.ts::return `\'${s.replace(/\'/g, `\'\\\\\'\'`)}\'`',
    'bash_structural_index.ts::return `"${s}"`',
    'hint_suggestion_guard.ts::if (unquotable(value)) return \'"\' + UNQUOTABLE + \'"\'',
    'hint_suggestion_guard.ts::if (REWRITTEN_IN_DOUBLE_QUOTES.test(value)) return "\'" + value + "\'"',
    'hint_suggestion_guard.ts::return \'"\' + value + \'"\'',
    'hint_suggestion_guard.ts::return held.map((v) => (single ? "\'" + v + "\'" : \'"\' + (REWRITTEN_IN_DOUBLE_QUOTES.test(v) ? UNQUOTABLE : v) + \'"\'))',
    'native_hook.ts::return `"${text}"`',
    'process_util.ts::if (process.platform === \'win32\') return `"${value}"`',
    'process_util.ts::return `"${value.replace(/[\\\\$`"]/g, \'\\\\$&\')}"`',
    'process_util.ts::return `\'${value.replace(/\'/g, "\'\\\\\'\'")}\'`',
    'process_util.ts::return `\'${value.replace(/\'/g, "\'\'")}\'`',
  ].map((key) => ({ key, reason: R.quoter })),
  ...[
    'hooks_bash_commands.ts::.replace(/"((?:[^"\\\\]|\\\\.)*)"/g, (_m, inner: string) => \'"\' + \' \'.repeat(inner.length) + \'"\')',
    'hooks_bash_commands.ts::.replace(/\'([^\']*)\'/g, (_m, inner: string) => "\'" + \' \'.repeat(inner.length) + "\'")',
  ].map((key) => ({ key, reason: R.blank })),
  ...[
    'csv_query.ts::return `"${cell.replace(/"/g, \'""\')}"`',
    'sqlite_query.ts::return `"${name.replace(/"/g, \'""\')}"`',
    'sqlite_query.ts::return `"${cell.replace(/"/g, \'""\')}"`',
    'index_reader.ts::.map((t) => \'"\' + t.replace(/"/g, \'""\') + \'"\')',
    'html_query.ts::.map(([k, v]) => (v !== \'\' ? `${k}="${v.replace(/"/g, \'&quot;\')}"` : k))',
    'xml_query.ts::attrParts.push(`${k}="${escapeXmlAttr(v)}"`)',
    'project_memory.ts::lines.push(`${k} = "${escaped}"`);',
  ].map((key) => ({ key, reason: R.format })),
  ...[
    'db.ts::tokenize=\'${FTS_TOKENIZER}\'',
    'index_reclaim.ts::const before = (db.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }).c',
    'index_reclaim.ts::db.prepare(`DELETE FROM "${table}"`).run()',
  ].map((key) => ({ key, reason: R.sqlConst })),
  ...[
    'bridges/zed_install.ts::return `@echo off\\r\\n"${nodePath}" "${cliPath}" mcp-serve\\r\\n`',
    'bridges/zed_install.ts::return `#!/bin/sh\\nexec "${nodePath}" "${cliPath}" mcp-serve\\n`',
    'bridges/shim_common.ts::try { process.stdout.write(\'${noOp}\') } catch {}`',
  ].map((key) => ({ key, reason: R.generated })),
  { key: 'process_util.ts::return spawnSync(existsSync(comspec) ? comspec : \'cmd.exe\', [\'/d\', \'/s\', \'/c\', `"${line}"`], { ...options, windowsVerbatimArguments: true })', reason: R.cmdLine },
  { key: 'languages/sql_idx.ts::return new RegExp(`(?<![\\\\w$])END\\\\s+(?:"${simple}"|${simple})\\\\s*;`, \'i\')', reason: R.regex },
  ...[
    'bash_extractors.ts::const path = /^[\\w-]+$/.test(target) ? target : "[\'" + target + "\']"',
    'hint_target.ts::if (!target.name.includes("\'")) return \'token-goat \' + format + \'-query \' + quotedArgs(shownPath, "[\'" + target.name + "\']").join(\' \')',
  ].map((key) => ({ key, reason: R.jsonPath })),
  { key: 'bash_extractors.ts::return \'sed -n \' + m[4]! + \' "\' + filePath + \'"\'', reason: R.sedRewrite },
  { key: 'hooks_bash_post.ts::const runCmd = cdHost === null ? bare : `cd \'${cdHost}\' && ${bare}`', reason: R.compressCmd },
  { key: 'hints/file_type_handler.ts::`Query with DuckDB: duckdb -c "SELECT * FROM read_parquet(\'${sqlLiteralPath(filePath)}\') LIMIT 10"`,', reason: R.duckdb },
  ...[
    'embed_tokenizer.ts::if (template !== \'[CLS] A [SEP]\') fail(`post_processor.single is "${template}", expected "[CLS] A [SEP]"`)',
    'embed_tokenizer.ts::if (typeof id !== \'number\' || !Number.isInteger(id)) fail(`model.vocab["${token}"] is not an integer id`)',
  ].map((key) => ({ key, reason: R.pinned })),
  ...[
    'mcp_compress_packs.ts::return `${indent}${uid} ${role} "${name.slice(0, SNAPSHOT_NAME_MAX_CHARS)}  … [${elided} chars elided]"${rest}`',
    'tool_filters/db_clients.ts::kept.push(...allKeys.slice(0, RedisCLIFilter.LIST_KEEP).map((k) => `"${k}"`))',
    'tool_filters/db_clients.ts::kept.push(...allKeys.map((k) => `"${k}"`))',
  ].map((key) => ({ key, reason: R.render })),
  { key: 'pack.ts::parts.push(`<document index="${docNum}">`)', reason: R.number },
  ...[
    'mcp_client_text.ts::const example = /["`]/.test(value) ? \'\' : ` (e.g. "${value}")`',
    'mcp_client_text.ts::return `the "${cmd}" tool again with a more specific ${param}${example}`',
  ].map((key) => ({ key, reason: R.mcpParam })),
  { key: 'read_semantic.ts::const payload = { source: \'fts\', items: [], truncated: false, totalCount: 0, excludeTestsFilteredToEmpty: true, hint: `no non-test matches for "${query}" (${hidden})` }', reason: R.jsonLeaf },
  ...[
    'powershell_compat.ts::return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(\'${Buffer.from(text, \'utf8\').toString(\'base64\')}\'))`',
    'powershell_compat.ts::bootstrap = `"exec(__import__(\'base64\').b64decode(\'${b64}\').decode())"`',
    'powershell_compat.ts::if (target.kind === \'stdout\') return `[System.Console]::OpenStandardOutput().Write([System.Convert]::FromBase64String(\'${Buffer.from(text, \'utf8\').toString(\'base64\')}\'), 0, ${Buffer.byteLength(text, \'utf8\')})`',
  ].map((key) => ({ key, reason: R.base64 })),
]

describe('every value echoed between hand-written quotes in src', () => {
  const nodes: ts.Expression[] = []
  const mark = (expr: ts.Expression): string => {
    nodes.push(expr)
    return OPEN + String(nodes.length - 1) + CLOSE
  }
  const lineOf = (expr: ts.Expression): string => {
    const sf = expr.getSourceFile()
    const { line } = sf.getLineAndCharacterOfPosition(expr.getStart())
    const starts = sf.getLineStarts()
    return sf.text.slice(starts[line], starts[line + 1] ?? sf.text.length).replace(/\r?\n$/, '').trim()
  }
  const hits = new Map<string, { key: string; where: string; expr: string }>()
  for (const t of [...stringTemplates(mark, "'"), ...stringTemplates(mark, '"')]) {
    for (const m of t.text.matchAll(HAND_QUOTED_VALUE)) {
      const expr = nodes[Number(m[2])]
      if (expr === undefined) continue
      const key = t.file + '::' + lineOf(expr)
      hits.set(key + '@' + expr.getText(), { key, where: t.file + ':' + t.line, expr: expr.getText().replace(/\s+/g, ' ') })
    }
  }
  const all = [...hits.values()]
  const allowed = new Set(QUOTES_ARE_SYNTAX.map((e) => e.key))

  it('is scanned', () => {
    pinnedPopulation({ what: 'hand-quoted interpolations in src string templates', items: [...new Set(all.map((h) => h.key))], floor: 30, mustInclude: [QUOTES_ARE_SYNTAX[0]!.key, 'db.ts::' + "tokenize='${FTS_TOKENIZER}'"] })
  })

  it('is echoedValue, quotedArg or fencedCommand everywhere but the lines whose quotes are syntax', () => {
    expect(all.filter((h) => !allowed.has(h.key)).map((h) => h.where + ' ' + h.expr)).toEqual([])
  })

  it('allows no line that no longer quotes a value by hand', () => {
    expect(QUOTES_ARE_SYNTAX.filter((e) => !all.some((h) => h.key === e.key)).map((e) => e.key)).toEqual([])
  })

  it('names one line per entry, with a reason', () => {
    expect(QUOTES_ARE_SYNTAX.filter((e) => e.reason.trim() === '' || !/^[\w/.-]+\.ts::\S/.test(e.key)).map((e) => e.key)).toEqual([])
    expect(new Set(QUOTES_ARE_SYNTAX.map((e) => e.key)).size).toBe(QUOTES_ARE_SYNTAX.length)
  })
  // HAND-DERIVED virtual sources: the shapes src carried (read_commands.ts `Symbol '${symbol}' not found in '${file}'`, read_section.ts ` (redirected from: '${result.redirectedFrom}')`, cli_file_ops.ts `inserted after '${result.heading}'`) beside the echoedValue form and a quoted literal.
  it('flags a value hand-quoted in either mark and passes an echoedValue one', () => {
    const virtual = (source: string): string[] => {
      const seen: string[] = []
      const standIn = (expr: ts.Expression): string => {
        seen.push(expr.getText())
        return OPEN + String(seen.length - 1) + CLOSE
      }
      return templatesIn('virtual.ts', source, standIn, "'").concat(templatesIn('virtual.ts', source, standIn, '"')).flatMap((t) => [...t.text.matchAll(HAND_QUOTED_VALUE)].map((m) => seen[Number(m[2])] ?? ''))
    }
    expect(virtual("const s = `Symbol '${symbol}' not found in '${file}'`")).toEqual(['symbol', 'file'])
    expect(virtual('const s = ` (redirected from: "${result.redirectedFrom}")`')).toEqual(['result.redirectedFrom'])
    expect(virtual('const s = `Symbol ${echoedValue(symbol)} not found in ${echoedValue(file)}`')).toEqual([])
    expect(virtual("const s = `inserted after 'Install' in ${file}`")).toEqual([])
  })
})

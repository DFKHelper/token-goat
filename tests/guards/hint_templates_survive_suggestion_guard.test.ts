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
  { file: 'bridges/grok_install.ts', reason: 'an installer refusal printed on stderr by `install --grok`' },
  { file: 'bridges/kimi_install.ts', reason: 'an installer refusal printed on stderr by `install --kimi`' },
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

/** The helpers that put one argument of a suggested command in double quotes: quotedArg (src/hint_suggestion_guard.ts) always, and answer_router.ts's viaArg whenever the value holds whitespace, which every stand-in below that tests quoting does. */
const QUOTING_HELPERS = new Set(['quotedArg', 'viaArg'])

/** A string expression's text with each interpolated value replaced by `standIn`, a value passed through a quoting helper by `standIn` in double quotes, and a command passed through fencedCommand (src/hint_suggestion_guard.ts) by its own flattened text in backticks, so the sentence around a fenced command is checked with the command in it rather than with a bare stand-in. */
function flatten(node: ts.Expression, standIn = PLAIN): string {
  if (ts.isParenthesizedExpression(node)) return flatten(node.expression, standIn)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => flatten(s.expression, standIn) + s.literal.text).join('')
  if (isConcat(node)) return flatten(node.left, standIn) + flatten(node.right, standIn)
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && QUOTING_HELPERS.has(node.expression.text)) return '"' + standIn + '"'
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fencedCommand' && node.arguments.length === 1) return '`' + flatten(node.arguments[0] as ts.Expression, standIn) + '`'
  return standIn
}

/** Every outermost string expression (literal, template, or `+` chain) in src naming `token-goat `, flattened around `standIn`. */
function stringTemplates(standIn: string): Array<{ file: string; line: number; text: string }> {
  const found: Array<{ file: string; line: number; text: string }> = []
  for (const abs of sourceFiles(SRC)) {
    const source = fs.readFileSync(abs, 'utf8')
    if (!source.includes('token-goat ')) continue
    const file = path.relative(SRC, abs).split(path.sep).join('/')
    const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || isConcat(node)) {
        let parent = node.parent
        while (ts.isParenthesizedExpression(parent)) parent = parent.parent
        if (!isConcat(parent)) {
          const text = flatten(node as ts.Expression, standIn)
          if (text.includes('token-goat ')) found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
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
      mustInclude: ['hooks_read_slice.ts::To edit it anyway', 'hooks_read.ts::' + PLAIN + ' was already read this session. Tool output spill files', 'hooks_bash.ts::token-goat available for this file type', 'hints/file_type_handler.ts::Then extract relevant pages'],
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

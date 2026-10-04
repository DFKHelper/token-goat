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
  { file: 'bridges/visualstudio_install.ts', reason: 'installer advice printed by `install --visualstudio`' },
  { file: 'bridges_status.ts', reason: 'evidence text shown by `doctor` and `bridges`' },
  { file: 'cli.ts', reason: 'commander help text' },
  { file: 'cli_cmd_analysis.ts', reason: 'commander help text' },
  { file: 'cli_doctor.ts', reason: '`doctor` report lines' },
  { file: 'cli_doctor_index.ts', reason: '`doctor` report lines; session start uses symbol_body_probe.ts, which names no command with a quoted argument' },
  { file: 'cli_doctor_platforms.ts', reason: '`doctor` report lines' },
  { file: 'cli_install.ts', reason: '`install`/`uninstall` output' },
  { file: 'embed_model.ts', reason: 'an embedding-status suggestion read by `semantic`, `doctor` and the MCP server, none of which a hook relays' },
  { file: 'read_semantic.ts', reason: '`semantic` command output' },
  { file: 'read_symbol.ts', reason: '`symbol` command output' },
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

/** A string expression's text with each interpolated value replaced by {@link PLAIN}. */
function flatten(node: ts.Expression): string {
  if (ts.isParenthesizedExpression(node)) return flatten(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => PLAIN + s.literal.text).join('')
  if (isConcat(node)) return flatten(node.left) + flatten(node.right)
  return PLAIN
}

/** Every outermost string expression (literal, template, or `+` chain) in src that names a `token-goat …` command with a double-quoted argument, keyed `file::text`. */
function suggestionTemplates(): Array<{ file: string; line: number; text: string }> {
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
          const text = flatten(node as ts.Expression)
          if (text.includes('token-goat ') && text.includes('"')) found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return found
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

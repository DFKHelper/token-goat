/** Guard: a command a hook suggests runs as printed, so it never carries a stand-in for a name the hook did not know. Hints used to fall back to `read "file::SymbolName"`, `section "file::Heading Name"`, `json-query "file" "<key>"`, `skill-section "x" "<heading>"`, `grep "<pattern>"` and the like whenever no real heading, symbol or key resolved, and an agent runs the command it is handed: each of those exits 1 or searches for a string no file holds. hint_target.ts now gives an unresolved target no name at all, so the compiler refuses a hint that pastes one. This guard covers the literals: every string and template piece in every src/ module the hook entry can load (static and dynamic imports) is scanned for a `::` stand-in name, a `<word>` argument inside a `token-goat` command or after a flag, and a bare `<word>` handed to a call as an argument (the way quotedArgs received `'<key>'`). Comments are not scanned. A literal that matches for another reason is listed in ALLOWED with why. */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The stand-in names hints spliced after a path and `::`, each one a part no file holds. `file::symbol` written with the word `file` is syntax described, not a command to run, and is not one. */
const NAMED_STAND_IN = /(?<!\bfile)::(?:SymbolName|SectionHeading|SectionName|sectionName|HeadingName|Heading Name|Heading|Symbol|symbol|DescribeBlockName|FunctionName|name|<[^>\n]*>)(?![\w-])/
/** A `<word>` argument inside a suggested command, or as a flag's value. */
const ANGLE_IN_COMMAND = /\btoken-goat [^`\n]*<[A-Za-z][\w -]*>|--[\w-]+[ =]['"]?<[A-Za-z][\w-]*>/
/** A literal that is nothing but a `<word>`, quoted or bare. */
const BARE_ANGLE = /^['"]?<[A-Za-z][\w -]*>['"]?$/

type Allowed = { file: string; text: string; reason: string }

/** Literals that match for a reason other than a stand-in, each matched on its file and a fragment of its text. */
const ALLOWED: readonly Allowed[] = [
  {
    file: 'src/hints/markdown_hints.ts',
    text: '::Heading Name',
    reason: 'The sample command in formatHeadingTreeParts, cut by hint_target.ts withoutSampleCommand before any hint carries the guidance; the literal stays because markdown_hints.ts is an embedding fingerprint source and an edit to it re-embeds every markdown file.',
  },
  {
    file: 'src/hints/file_type_handler.ts',
    text: '<text>',
    reason: 'The pattern of the SVG label search, which looks for the `<text>` element itself: a real string every labelled SVG holds, not a stand-in for one.',
  },
  ...['<base64>', '<oldfile>', '<newfile>'].map((text) => ({
    file: 'src/hooks_read_slice.ts',
    text,
    reason: 'The edit-anyway escape hatch on a large-file deny: the value is the agent\'s own replacement text, encoded, which no hook can know before the agent writes it.',
  })),
  {
    file: 'src/hooks_agent_spawn.ts',
    text: 'Before your first read of any file',
    reason: 'The read gate a subagent brief carries, which teaches the command forms (`symbol <name>`) before the subagent has a target; it names no file and suggests no command to run as printed.',
  },
  {
    file: 'src/hooks_agent_spawn.ts',
    text: 'Report contract',
    reason: 'The citation form a subagent brief asks reports to use, `mcp-output <id> --full`, where the id is whichever recall the subagent will cite; it describes a shape, not a command to run.',
  },
  {
    file: 'src/manifest.ts',
    text: 'cite the recall id',
    reason: 'The compaction directive asking the summary to cite recall ids by the form `bash-output <id> --full`; the ids are the ones the session produced, which the summary writer holds and this text cannot.',
  },
  {
    file: 'src/project_memory.ts',
    text: 'Project notes',
    reason: 'The heading over saved project notes, naming the command that adds one; the key and finding are the agent\'s own, written when it has one, so no hook can fill them.',
  },
  {
    file: 'src/session_reminder.ts',
    text: 'Record a finding',
    reason: 'The session reminder naming the command that saves a finding; the key and finding are the agent\'s own, written when it has one, so no hook can fill them.',
  },
  {
    file: 'src/session_reminder.ts',
    text: 'prefer surgical reads',
    reason: 'The session-start reminder teaching the command forms in general, before any file is in play; it names no file and suggests no command to run as printed.',
  },
  {
    file: 'src/read_structured_data.ts',
    text: '--xpath <expression>',
    reason: 'A usage error from xml-query telling the caller it passed neither a path nor an expression, naming what the missing argument is, the way any CLI usage line does.',
  },
  ...['<path>', '<q>'].map((text) => ({
    file: 'src/tool_error_class.ts',
    text,
    reason: 'Tokens a tool error is normalized to before it is classified, so two errors that differ only in a path or a quoted value group together; never printed as a command.',
  })),
  {
    file: 'src/tool_filters/shell_file.ts',
    text: '--include=<glob>',
    reason: 'The grep summary naming grep\'s own --include flag and the kind of value it takes, in a sentence rather than a command; the glob depends on which files the agent wants, which the filter cannot know.',
  },
]

type Hit = { file: string; line: number; text: string }

/** The command surface: a hook that loads it (the relay's `token-goat <command>` fallbacks do) runs a command, whose usage text and errors name their arguments the way any CLI does. Its modules are not hint producers, and the walk does not follow their imports. */
const COMMAND_SURFACE = /^src\/(?:cli(?:_[a-z_]+)?|mcp_server|main)\.ts$/

/** Every src/ module the hook entry can load, through static and dynamic imports alike, short of the command surface: a hint built in a lazily loaded handler reaches the agent the same way. */
async function hookModules(): Promise<string[]> {
  const result = await esbuild.build({
    absWorkingDir: REPO,
    entryPoints: ['src/hook_lib.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    write: false,
    metafile: true,
    splitting: true,
    outdir: 'unused',
    packages: 'external',
    define: { 'import.meta.env': '{}', __TG_MANIFEST__: JSON.stringify('{"version":"0.0.0-test"}') },
    logLevel: 'silent',
  })
  const inputs = result.metafile.inputs
  const seen = new Set<string>(['src/hook_lib.ts'])
  const queue = ['src/hook_lib.ts']
  while (queue.length > 0) {
    for (const imp of inputs[queue.shift()!]?.imports ?? []) {
      if (imp.external || seen.has(imp.path) || COMMAND_SURFACE.test(imp.path)) continue
      seen.add(imp.path)
      queue.push(imp.path)
    }
  }
  return [...seen].filter((p) => p.startsWith('src/') && p.endsWith('.ts') && !p.endsWith('.d.ts')).sort()
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text
  return null
}

function hitsIn(rel: string): Hit[] {
  const source = ts.createSourceFile(rel, readFileSync(path.join(REPO, rel), 'utf8'), ts.ScriptTarget.Latest, true)
  const hits: Hit[] = []
  const visit = (node: ts.Node): void => {
    const text = literalText(node)
    if (text !== null) {
      const argument = ts.isCallExpression(node.parent) && node.parent.arguments.some((a) => a === node)
      if (NAMED_STAND_IN.test(text) || ANGLE_IN_COMMAND.test(text) || (argument && BARE_ANGLE.test(text))) {
        hits.push({ file: rel, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

function allowedFor(hit: Hit): Allowed | undefined {
  return ALLOWED.find((a) => a.file === hit.file && hit.text.includes(a.text))
}

describe('suggested commands in hook output carry no stand-in name', () => {
  let modules: string[] = []
  let hits: Hit[] = []
  beforeAll(async () => {
    modules = await hookModules()
    hits = modules.flatMap(hitsIn)
  }, 60_000)

  it('scans the hint producers, so a clean result is not vacuous', () => {
    for (const producer of ['src/hint_target.ts', 'src/hooks_read.ts', 'src/hooks_grep.ts', 'src/hooks_bash.ts', 'src/hooks_skill.ts', 'src/hooks_mcp.ts', 'src/hints/file_type_handler.ts', 'src/fold_structure.ts']) {
      expect(modules, producer).toContain(producer)
    }
  })

  it('finds no stand-in outside the allowed literals', () => {
    const offenders = hits.filter((h) => allowedFor(h) === undefined).map((h) => `${h.file}:${h.line} ${JSON.stringify(h.text.slice(0, 160))}`)
    expect(offenders, 'fill the name from hint_target.ts, or leave the command out when none resolves').toEqual([])
  })

  it('keeps every ALLOWED entry matched to a live literal', () => {
    for (const a of ALLOWED) {
      expect(hits.some((h) => allowedFor(h) === a), `ALLOWED entry for ${a.file} matches nothing any more; delete it`).toBe(true)
      expect(a.reason.length).toBeGreaterThan(40)
    }
  })
})

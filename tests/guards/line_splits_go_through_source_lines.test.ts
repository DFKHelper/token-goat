/** Guard: no file under src/ cuts text into lines on a bare LF or on CRLF only. The index reads a lone CR as a line break (normalizeSourceText in src/source_text.ts), so a reader that cuts on `\n` or `\r?\n` sees a CR-only file as one line and prints a wrong line number, a preview that is the whole file, or no match at all; src/source_lines.ts is the one helper that cuts the way the index does, and a reader of a file's text goes through it. The scan reads every src/**.ts file with the TypeScript compiler API and finds a call to a member named `split` (or `split.call`, or a computed member it cannot resolve, which counts as a match) whose separator is a string, template or regex literal, a `new RegExp(literal)`, or a same-file `const` bound to one, that names a line break (an LF, a CR, or a regex source that spells one) and does not also cut a lone CR. A separator that cuts all three endings (`/\r\n|\r|\n/`) passes on its own; a spread argument cannot be resolved and counts as a match. What it cannot see: a call through `split.apply`, a separator held in a parameter, a property or a call result, a line cut made by `match`/`matchAll`/`indexOf('\n')`/`readline`, and a split on a character other than a newline. Every site it does flag must be in ALLOWED below with a reason that names where the receiver's text comes from, so a new site is a decision someone wrote down, not a drift. */
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', '..', 'src')

/** The helper itself holds the one raw cut, so it is the only file not scanned. */
const HELPER = 'source_lines.ts'

interface Site {
  readonly file: string
  readonly line: number
  readonly text: string
}

type Separator = { readonly kind: 'string'; readonly value: string } | { readonly kind: 'regex'; readonly source: string; readonly flags: string }

function unwrap(node: ts.Expression): ts.Expression {
  let cur = node
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression
  return cur
}

function templateText(node: ts.TemplateExpression): string {
  return node.head.text + node.templateSpans.map((s) => s.literal.text).join('')
}

/** The literal separator an expression spells, or null when it spells none. A same-file const resolves to what it is bound to. */
function separatorOf(node: ts.Expression, consts: ReadonlyMap<string, readonly ts.Expression[]>, depth = 0): Separator[] | null {
  const expr = unwrap(node)
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [{ kind: 'string', value: expr.text }]
  if (ts.isTemplateExpression(expr)) return [{ kind: 'string', value: templateText(expr) }]
  if (ts.isRegularExpressionLiteral(expr)) {
    const end = expr.text.lastIndexOf('/')
    return [{ kind: 'regex', source: expr.text.slice(1, end), flags: expr.text.slice(end + 1) }]
  }
  if ((ts.isNewExpression(expr) || ts.isCallExpression(expr)) && ts.isIdentifier(expr.expression) && expr.expression.text === 'RegExp') {
    const first = expr.arguments?.[0]
    if (first === undefined) return null
    const inner = separatorOf(first, consts, depth + 1)
    if (inner === null || inner[0]?.kind !== 'string') return null
    const flagArg = expr.arguments?.[1]
    const flags = flagArg !== undefined && ts.isStringLiteral(unwrap(flagArg)) ? (unwrap(flagArg) as ts.StringLiteral).text : ''
    return [{ kind: 'regex', source: inner[0].value, flags }]
  }
  if (ts.isIdentifier(expr) && depth < 3) {
    const bound = consts.get(expr.text)
    if (bound === undefined) return null
    const found = bound.flatMap((b) => separatorOf(b, consts, depth + 1) ?? [])
    return found.length > 0 ? found : null
  }
  return null
}

function constsOf(source: ts.SourceFile): Map<string, ts.Expression[]> {
  const map = new Map<string, ts.Expression[]>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      map.set(node.name.text, [...(map.get(node.name.text) ?? []), node.initializer])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return map
}

/** Whether the separator names a line break at all: an LF or CR character, or a regex source that spells one (`\n`, `\r`, `\x0a`, `\u000a`, `\cJ`). */
function namesLineBreak(sep: Separator): boolean {
  const text = sep.kind === 'string' ? sep.value : sep.source
  if (/[\n\r]/.test(text)) return true
  return sep.kind === 'regex' && /\\(?:n|r|x0[aAdD]|u000[aAdD]|c[jJmM])/.test(text)
}

/** Whether `'a\rb'.split(separator)` cuts at the lone CR, the way the index does. An unparseable regex counts as not cutting it, so it is flagged. */
function cutsLoneCr(sep: Separator): boolean {
  try {
    const parts = sep.kind === 'string' ? 'a\rb'.split(sep.value) : 'a\rb'.split(new RegExp(sep.source, sep.flags))
    return parts.length > 1 && parts[0] === 'a' && parts[parts.length - 1] === 'b'
  } catch {
    return false
  }
}

function isFlagged(seps: readonly Separator[]): boolean {
  return seps.some((s) => namesLineBreak(s) && !cutsLoneCr(s))
}

/** Every call under `source` that cuts text into lines the way this guard forbids. */
function lineSplitSites(file: string, text: string): Site[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const consts = constsOf(sf)
  const sites: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      let args: readonly ts.Expression[] | null = null
      let unresolvedCallee = false
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === 'split') args = node.arguments
        else if ((callee.name.text === 'call' || callee.name.text === 'apply') && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'split') args = node.arguments.slice(1)
      } else if (ts.isElementAccessExpression(callee)) {
        const key = unwrap(callee.argumentExpression)
        if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
          if (key.text === 'split') args = node.arguments
        } else {
          unresolvedCallee = true
          args = node.arguments
        }
      }
      if (args !== null) {
        const spread = args.some((a) => ts.isSpreadElement(a))
        const seps = args.slice(0, 1).flatMap((a) => (ts.isSpreadElement(a) ? [] : (separatorOf(a, consts) ?? [])))
        const anyNewline = args.some((a) => !ts.isSpreadElement(a) && (separatorOf(a, consts) ?? []).some(namesLineBreak))
        const hit = spread || (unresolvedCallee ? anyNewline : isFlagged(seps))
        if (hit) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          sites.push({ file, line: line + 1, text: node.getText(sf).split('\n')[0]!.trim().slice(0, 110) })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

function srcFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true }) as Dirent[]) {
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...srcFiles(dir, next))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && next !== HELPER) out.push(next)
  }
  return out.sort()
}

interface Allowed {
  /** A file under src/, or a directory under src/ ending in `/` for a family of files that share one receiver. */
  readonly path: string
  /** The exact number of flagged sites in the file, or in the whole directory. */
  readonly sites: number
  /** Where the receiver's text comes from, as read off the code. */
  readonly reason: string
}

const ALLOWED: readonly Allowed[] = [
  { path: 'bash_extractors.ts', sites: 1, reason: 'splits a shell command string, not file text' },
  { path: 'bash_output_cache.ts', sites: 3, reason: 'splits git stdout and the cached stdout of two runs of a command, not a source file' },
  { path: 'bash_range_savings.ts', sites: 1, reason: 'counts bytes of a shell range read to price a savings gate and never prints a line; a lone-CR file prices the wrong window (follow-up)' },
  { path: 'bridges/copilot_hooks_owners.ts', sites: 1, reason: 'splits a host hook config file the installer wrote, not a source file' },
  { path: 'change_claim.ts', sites: 1, reason: 'splits the first item of a claim the agent wrote, not a file' },
  { path: 'claude_hidden_rules.ts', sites: 2, reason: 'splits agent frontmatter and a .git file (one gitdir: line), neither is indexed source' },
  { path: 'cli_cached_output.ts', sites: 1, reason: 'splits cached command output; extractSection on it is a recall of stdout, not a file' },
  { path: 'cli_diagnostics.ts', sites: 1, reason: 'splits the pattern list of an ignore file read for diagnostics, no line number printed' },
  { path: 'cli_dispatch.ts', sites: 1, reason: 'splits a file list read from stdin, one path per line' },
  { path: 'cli_doctor.ts', sites: 2, reason: 'splits an error message and the stdout of a probe command' },
  { path: 'cli_doctor_process.ts', sites: 2, reason: 'splits the stderr and the ps listing of a spawned command' },
  { path: 'cli_file_ops.ts', sites: 3, reason: 'the replace command works on raw bytes; its closest-match window and inserted lines count LF only, so a lone-CR file reports line 1 (follow-up)' },
  { path: 'cli_memory.ts', sites: 1, reason: 'splits a memory file token-goat wrote, not indexed source' },
  { path: 'command_error.ts', sites: 4, reason: 'splits stderr and error text for display' },
  { path: 'compact.ts', sites: 1, reason: 'splits the session manifest token-goat built' },
  { path: 'conflict_query.ts', sites: 1, reason: 'indentBlock indents text already cut by sourceLines in parseConflicts, so it only rejoins lines' },
  { path: 'copilot_waste.ts', sites: 1, reason: 'splits a host log file read for waste statistics, no line number printed' },
  { path: 'coverage_query.ts', sites: 1, reason: 'parses an lcov or coverage report into numbers, no line of the file is printed' },
  { path: 'dep_docs.ts', sites: 1, reason: 'takes the first non-blank line of fetched dependency documentation, not indexed source' },
  { path: 'dirty_queue.ts', sites: 2, reason: 'splits queue/dirty.txt, a list of paths token-goat wrote one per line' },
  { path: 'doc_compact.ts', sites: 5, reason: 'splits compact files token-goat wrote itself, and the markdown body it compacts, never printing source line numbers' },
  { path: 'doctor_probe.ts', sites: 2, reason: 'splits the output of a probe command for the doctor report' },
  { path: 'dotenv_redact.ts', sites: 1, reason: 'redaction keeps the line count of its input; a lone-CR dotenv stays one line and is redacted whole' },
  { path: 'edit_near_miss.ts', sites: 1, reason: 'splits the old_string of a failed edit, not the file; the file side goes through its own splitLines' },
  { path: 'embeddings.ts', sites: 1, reason: 'the one line cut after normalizeSourceText in the embedding chunker' },
  { path: 'failures.ts', sites: 1, reason: 'splits test-runner output' },
  { path: 'fence_cap.ts', sites: 1, reason: 'splits redacted text rejoined from lines that were cut already' },
  { path: 'fold_delivery.ts', sites: 1, reason: 'compares disk lines with the rows the harness delivered and folds nothing on a mismatch, so a lone-CR file is left whole' },
  { path: 'git_hint.ts', sites: 1, reason: 'reads the first line of a file for a shebang or marker test, nothing printed' },
  { path: 'graph_analysis.ts', sites: 1, reason: 'splits the output of a graph query for json rendering' },
  { path: 'graph_commands.ts', sites: 1, reason: 'splits token-goat own ambiguity message' },
  { path: 'hint_stats.ts', sites: 1, reason: 'splits a correlator string token-goat built' },
  { path: 'hint_target.ts', sites: 1, reason: 'splits sectionsList, a list token-goat formatted itself' },
  { path: 'hooks_agent_spawn.ts', sites: 5, reason: 'splits the prompt text of a spawned agent and its fenced blocks, not an indexed file' },
  { path: 'hooks_bash_post.ts', sites: 4, reason: 'splits shell output and git diff output the hook handed over' },
  { path: 'hooks_cli.ts', sites: 1, reason: 'splits a patch text for the paths it names' },
  { path: 'hooks_read.ts', sites: 3, reason: 'lineWindowBytes measures bytes of a Read window for a size gate and prints no line; the shell test reads a normalized-text head; the guidance is token-goat text' },
  { path: 'hooks_read_post.ts', sites: 2, reason: 'compares the line counts of delivered text before and after a rewrite' },
  { path: 'hooks_read_slice.ts', sites: 8, reason: 'works on text the harness delivered numbered (cat -n rows) or two versions of a doc, so rows already carry the harness numbers' },
  { path: 'hooks_taskoutput.ts', sites: 1, reason: 'splits the output of a task, not a source file' },
  { path: 'hooks_tool_failure.ts', sites: 1, reason: 'takes the first line of the old_string of a failed edit, not the file' },
  { path: 'import_export_extract.ts', sites: 2, reason: 'extracts import and export names for a hint; no line number is printed (a lone-CR file sees one line, behavior-neutral)' },
  { path: 'install.ts', sites: 2, reason: 'splits the host config and skill files the installer wrote' },
  { path: 'languages/', sites: 75, reason: 'extractors take the text parseContent in parser.ts already normalized with normalizeSourceText, so no lone CR is left to cut' },
  { path: 'listing_size.ts', sites: 1, reason: 'splits a token-goat listing report' },
  { path: 'manifest.ts', sites: 1, reason: 'splits the notes block token-goat built' },
  { path: 'mcp_compress_packs.ts', sites: 2, reason: 'splits tool results of other MCP servers, not a file' },
  { path: 'memory_prune.ts', sites: 2, reason: 'splits agent memory files, not indexed source' },
  { path: 'notes.ts', sites: 1, reason: 'the receiver is indexedSourceText, which already normalized the text' },
  { path: 'openapi_query.ts', sites: 1, reason: 'splits JSON.stringify output, which only ever holds LF' },
  { path: 'overflow_guard.ts', sites: 1, reason: 'splits tool output the guard caps, not a file' },
  { path: 'pack.ts', sites: 3, reason: 'comment stripping counts LF in text it replaces with LF, and the path list from stdin has one path per line' },
  { path: 'parser.ts', sites: 6, reason: 'cuts content parseContent normalized on the first line of that function' },
  { path: 'parser_structured.ts', sites: 7, reason: 'extractors take the text parseContent normalized before it dispatches to them' },
  { path: 'parser_types.ts', sites: 1, reason: 'language detection reads the first lines to pick VB6, nothing printed' },
  { path: 'path_miss.ts', sites: 1, reason: 'splits the stderr of a failed command' },
  { path: 'pr_slice.ts', sites: 1, reason: 'splits a git diff' },
  { path: 'process_tree.ts', sites: 1, reason: 'splits the process listing of a spawned command' },
  { path: 'project_memory.ts', sites: 1, reason: 'splits notes token-goat wrote itself, one per line' },
  { path: 'read_commands.ts', sites: 1, reason: 'resolveBody cuts a stored body that was rejoined with LF when it was indexed' },
  { path: 'read_git.ts', sites: 6, reason: 'splits git diff and git stdout' },
  { path: 'read_inspect.ts', sites: 1, reason: 'splits a JSONL transcript, one record per line, and the lone CR cannot end a JSON record' },
  { path: 'read_meta.ts', sites: 1, reason: 'previewLines cuts a body resolveBody already rejoined with LF' },
  { path: 'read_outline.ts', sites: 2, reason: 'the receiver is indexedSourceText output, and the docstring is redacted text from the index' },
  { path: 'read_refs.ts', sites: 2, reason: 'splits token-goat own ambiguity message' },
  { path: 'read_section.ts', sites: 4, reason: 'cuts a section body that sourceLines already cut and rejoined with LF' },
  { path: 'read_spec.ts', sites: 1, reason: 'splits token-goat own ambiguity message' },
  { path: 'read_suggest.ts', sites: 1, reason: 'cuts a symbol body resolveBody rejoined with LF' },
  { path: 'read_symbol.ts', sites: 1, reason: 'cuts a body resolveBody rejoined with LF' },
  { path: 'recovery_pairs.ts', sites: 1, reason: 'splits redacted error text of a failed command' },
  { path: 'repomap.ts', sites: 1, reason: 'splits git stdout' },
  { path: 'resident_context.ts', sites: 1, reason: 'splits the tail of a transcript JSONL, one record per line' },
  { path: 'resident_process.ts', sites: 1, reason: 'splits ps output' },
  { path: 'resume.ts', sites: 1, reason: 'splits git stdout' },
  { path: 'rewrite_permission.ts', sites: 1, reason: 'splits a shell command into its parts' },
  { path: 'section_reader.ts', sites: 3, reason: 'cuts text readSection normalized with normalizeSourceText and extractSection takes from cached stdout or normalized callers' },
  { path: 'served_lines.ts', sites: 1, reason: 'splits the output token-goat served earlier' },
  { path: 'skill_cache.ts', sites: 5, reason: 'splits the body of a skill file, which is markdown prose and not indexed source' },
  { path: 'text_commands.ts', sites: 2, reason: 'parses lock files and logs into entries, no line of the file is printed' },
  { path: 'text_logfold.ts', sites: 1, reason: 'folds log text pasted or piped in, where a CR is a progress redraw' },
  { path: 'text_trace.ts', sites: 1, reason: 'splits a stack trace pasted or piped in' },
  { path: 'tool_error_class.ts', sites: 1, reason: 'splits the error text of a failed tool call' },
  { path: 'tool_filters/', sites: 229, reason: 'every filter takes the output of the command the bash hook ran (build, test, git, listing), never a source file read' },
  { path: 'transcript_extract.ts', sites: 1, reason: 'splits a transcript, one record per line' },
  { path: 'util.ts', sites: 2, reason: 'a git shim file read by line, and countContentLines, which the indexers call on parseContent-normalized text' },
  { path: 'util_context.ts', sites: 1, reason: 'the receiver is indexedSourceText output' },
  { path: 'verification_state.ts', sites: 3, reason: 'splits a shell command' },
  { path: 'waste.ts', sites: 1, reason: 'splits a JSONL transcript read in chunks, one record per line' },
  { path: 'worker_lifecycle.ts', sites: 1, reason: 'splits the output of a process listing' },
  { path: 'xml_query.ts', sites: 2, reason: 'splits XML token-goat serialized itself with LF' },
]

function allowedFor(file: string): Allowed | undefined {
  return ALLOWED.find((a) => (a.path.endsWith('/') ? file.startsWith(a.path) : a.path === file))
}

describe('src never cuts text into lines on LF alone', () => {
  const files = pinnedPopulation({
    what: 'src/**/*.ts files scanned for a line split',
    items: srcFiles(SRC),
    floor: 400,
    mustInclude: ['read_commands.ts', 'read_section.ts', 'languages/apex.ts', 'tool_filters/'],
  })
  const bySite = new Map<string, Site[]>()
  for (const f of files) {
    const sites = lineSplitSites(f, readFileSync(path.join(SRC, f), 'utf8'))
    if (sites.length > 0) bySite.set(f, sites)
  }

  it('finds every flagged site in a file named in the allowlist, and in no other', () => {
    const unlisted: string[] = []
    for (const [file, sites] of bySite) {
      if (allowedFor(file) === undefined) unlisted.push(...sites.map((s) => `${s.file}:${s.line}: ${s.text}`))
    }
    expect(unlisted, 'these cut text on LF or CRLF only; cut it with sourceLines (src/source_lines.ts), or add the file to ALLOWED with the reason its text is not a file read').toEqual([])
  })

  it('counts exactly the sites each allowlist entry names', () => {
    const counts: string[] = []
    for (const a of ALLOWED) {
      const total = [...bySite].filter(([file]) => (a.path.endsWith('/') ? file.startsWith(a.path) : file === a.path)).reduce((n, [, sites]) => n + sites.length, 0)
      if (total !== a.sites) counts.push(`${a.path}: allowlisted ${a.sites}, found ${total}`)
    }
    expect(counts, 'an allowlist entry that names the wrong number of sites hides a new split or a removed one').toEqual([])
  })

  it('gives every allowlist entry a one-line reason and lists no path twice', () => {
    expect(ALLOWED.filter((a) => a.reason.trim() === '' || a.reason.includes('\n'))).toEqual([])
    expect(new Set(ALLOWED.map((a) => a.path)).size).toBe(ALLOWED.length)
  })
})

/** Sample sources, each spelling one shape the scan has to see or has to let through; the expected count is how many sites the scan must report. Fixture provenance: HAND-DERIVED, each sample is one line written to hold the shape named beside it. */
const SAMPLES: ReadonlyArray<readonly [string, string, number]> = [
  ['a string literal LF', "const a = text.split('\\n')", 1],
  ['a string literal CRLF', "const a = text.split('\\r\\n')", 1],
  ['a template literal LF', 'const a = text.split(`\\n`)', 1],
  ['a regex literal with an optional CR', 'const a = text.split(/\\r?\\n/)', 1],
  ['a regex literal LF', 'const a = text.split(/\\n/)', 1],
  ['a capturing group that keeps the break it cuts at', 'const a = text.split(/(\\r\\n|\\n|\\r)/)', 0],
  ['a regex that cuts a paragraph', 'const a = text.split(/\\n\\s*\\n/)', 1],
  ['a RegExp built from a string', "const a = text.split(new RegExp('\\\\r?\\\\n'))", 1],
  ['a same-file string const', "const NL = '\\n'\nconst a = text.split(NL)", 1],
  ['a same-file regex const', 'const LINE_RE = /\\r?\\n/\nconst a = text.split(LINE_RE)', 1],
  ['an optional-chained split', "const a = text?.split('\\n')", 1],
  ['a split under a cast and parentheses', "const a = text.split(('\\n' as string))", 1],
  ['a quoted member name', "const a = text['split']('\\n')", 1],
  ['a computed member name', "const k = 'split'\nconst a = text[k]('\\n')", 1],
  ['a computed key from a call, which fails closed', "const a = text[pick()]('\\n')", 1],
  ['an op-keyed member', "const a = text[ops.split]('\\n')", 1],
  ['a split inside a member assignment', "api.lines = (t: string) => t.split('\\n')", 1],
  ['a split inside Object.assign', "Object.assign(api, { lines: (t: string) => t.split(/\\r?\\n/) })", 1],
  ['split.call',"const a = String.prototype.split.call(text, '\\n')", 1],
  ['split.apply with an array literal, which the scan cannot see', "const a = String.prototype.split.apply(text, ['\\n'])", 0],
  ['a spread argument', 'const a = text.split(...args)', 1],
  ['two splits on one line', "const a = [x.split('\\n'), y.split(/\\r?\\n/)]", 2],
  ['a regex that cuts LF, CRLF and a lone CR', 'const a = text.split(/\\r\\n|\\r|\\n/)', 0],
  ['a class that cuts either break', 'const a = text.split(/[\\r\\n]+/)', 0],
  ['a split on a comma', "const a = text.split(',')", 0],
  ['a split on whitespace', 'const a = text.split(/\\s+/)', 0],
  ['a separator held in a parameter, which the scan cannot see', 'function f(text: string, sep: string) { return text.split(sep) }', 0],
  ['a name that is not split', "const a = text.splice('\\n')", 0],
]

describe('the line-split scan', () => {
  it.each(SAMPLES)('reports the right number of sites for %s', (_name, source, expected) => {
    expect(lineSplitSites('sample.ts', source)).toHaveLength(expected)
  })

  it('names the line of the site', () => {
    const sites = lineSplitSites('sample.ts', "const a = 1\nconst b = text.split('\\n')\n")
    expect(sites.map((s) => s.line)).toEqual([2])
  })
})

/** The line extents a successful `token-goat read` or `token-goat section` call handed the model, so the session's served-range ledger counts them like a sliced Read does. Only `read` and `section` name their file in the command; `symbol NAME` does not, so it has no extent to place. */

export interface ServedExtent {
  filePath: string
  start: number
  end: number
}

/** Flags that stop the call printing the whole symbol or section, so its extent no longer says what was shown: a cut (`--grep`, `--max-lines`, `--head`), another output (`--json`/`-j`, `--stats`, `--list`, which prints headings), or usage text (`--help`/`-h`). Any short cluster holding `j` or `h` counts, which only errs toward recording nothing. */
const NARROWING_FLAG = /\s(?:--(?:grep|max-lines|head|tail|section|stats|json|list|help)\b|-[A-Za-gik-z]*[jh])/

/** The `@N` / `@N-M` suffix of `spec`, or null. A `::` before the suffix means the `@` anchors a symbol line, not a range. */
function rangeSuffix(spec: string): { file: string; start: number; end: number } | null {
  const m = /^(.+)@(\d+)(?:-(\d+))?$/.exec(spec)
  if (m === null || m[1]!.includes('::')) return null
  const start = parseInt(m[2]!, 10)
  return { file: m[1]!, start, end: m[3] !== undefined ? parseInt(m[3], 10) : start }
}

/** An unquoted pipe, redirect, `;` or `&` (the character class of WHOLE_FILE_READ's operand), after which the printed text is cut or sent elsewhere. */
const SHELL_OPERATOR = /[|<>;&]/

/** A trailing stderr-only redirect (`2>/dev/null`, `2>&1`, PowerShell's `2>$null`): it hides nothing the model sees on stdout, which is what a read's text is. A stdout redirect (`>/dev/null`, `1>`) is not one. */
const STDERR_ONLY_TAIL = /(?:[ \t]+2>[ \t]*(?:\/dev\/null|&1|\$null))+[ \t]*$/

/** The extents served by `token-goat <sub> <spec>` as `extractTgSurgicalRead` classified it (`spec` holds the resolved file path). Best-effort: an unresolvable or ambiguous spec yields nothing, and so does a command whose flags narrow the output. The resolvers load on demand because this runs on the hook path. */
export async function servedExtents(sub: string, spec: string, cmd: string, projectRoot: string | null): Promise<ServedExtent[]> {
  if (NARROWING_FLAG.test(cmd)) return []
  const { maskQuotedSpans } = await import('./tool_filters/helpers.js')
  if (SHELL_OPERATOR.test(maskQuotedSpans(cmd).replace(STDERR_ONLY_TAIL, ''))) return []
  if (sub === 'read') {
    const range = rangeSuffix(spec)
    if (range !== null) return range.end >= range.start ? [{ filePath: range.file, start: range.start, end: range.end }] : []
  }
  const { parseColonLineRange, parseReadSpec, resolveSymbolSpec } = await import('./read_spec.js')
  const { file, symbol } = parseReadSpec(spec)
  if (symbol === undefined || symbol === '') return []
  if (sub === 'section') {
    const [{ readSection }, { readFileText }] = await Promise.all([import('./section_reader.js'), import('./read_commands.js')])
    const hit = readSection(file, symbol, readFileText)
    return hit !== null && hit.occurrences === undefined ? [{ filePath: file, start: hit.lineStart, end: hit.lineEnd }] : []
  }
  if (sub !== 'read') return []
  const colonRange = parseColonLineRange(symbol)
  if (colonRange !== null) return [{ filePath: file, start: colonRange.start, end: colonRange.end }]
  const extents: ServedExtent[] = []
  for (const name of symbol.split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
    const resolution = resolveSymbolSpec(`${file}::${name}`, undefined, projectRoot ?? undefined)
    if (resolution.kind === 'ok') extents.push({ filePath: resolution.entry.filePath, start: resolution.entry.lineStart, end: resolution.entry.lineEnd })
  }
  return extents
}

/** A bare `token-goat read <file>`: one spec, no flag, pipe or redirect, so the call printed the file's whole text. */
const WHOLE_FILE_READ = /^(?:token-goat|tg)\s+read\s+(?:"[^"]+"|'[^']+'|[^\s"'|<>;&-][^\s|<>;&]*)\s*$/

/** True when `cmd` is a bare `token-goat read` of `spec`'s file with nothing after the file: `spec` is the resolved path alone (no `::symbol`, no `@range`) and no flag narrows the output. Such a call counts as a full read of the file. */
export function isWholeFileRead(sub: string, spec: string, filePath: string, cmd: string): boolean {
  return sub === 'read' && spec === filePath && WHOLE_FILE_READ.test(cmd.trim())
}

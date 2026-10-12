/** The line extents a successful `token-goat read` or `token-goat section` call handed the model, so the session's served-range ledger counts them like a sliced Read does. Only `read` and `section` name their file in the command; `symbol NAME` does not, so it has no extent to place. */

export interface ServedExtent {
  filePath: string
  start: number
  end: number
}

/** Flags that cut what the call prints to less than the whole symbol or section, so its extent no longer says what was shown. */
const NARROWING_FLAG = /\s--(?:grep|max-lines|head|tail|section|stats|json)\b/

/** The `@N` / `@N-M` suffix of `spec`, or null. A `::` before the suffix means the `@` anchors a symbol line, not a range. */
function rangeSuffix(spec: string): { file: string; start: number; end: number } | null {
  const m = /^(.+)@(\d+)(?:-(\d+))?$/.exec(spec)
  if (m === null || m[1]!.includes('::')) return null
  const start = parseInt(m[2]!, 10)
  return { file: m[1]!, start, end: m[3] !== undefined ? parseInt(m[3], 10) : start }
}

/** The extents served by `token-goat <sub> <spec>` as `extractTgSurgicalRead` classified it (`spec` holds the resolved file path). Best-effort: an unresolvable or ambiguous spec yields nothing, and so does a command whose flags narrow the output. The resolvers load on demand because this runs on the hook path. */
export async function servedExtents(sub: string, spec: string, cmd: string, projectRoot: string | null): Promise<ServedExtent[]> {
  if (NARROWING_FLAG.test(cmd)) return []
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

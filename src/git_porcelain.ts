/** Reading `git status --porcelain -z`, the unquoted NUL-separated listing of changed and untracked paths. */

/** One entry of `git status --porcelain -z`: the path as git names it, relative to the repository root, plus the path a rename or copy came from. */
export interface PorcelainEntry {
  path: string
  origPath?: string
}

/** Parse `git status --porcelain -z` output. Each record is `XY path` ended by NUL, with no quoting, so a non-ASCII name or one holding ` -> ` comes through as written; a rename or copy (R or C in either column) is followed by one more NUL-ended field, the original path, which carries no status prefix. */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] {
  const fields = stdout.split('\x00')
  const out: PorcelainEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const entry: PorcelainEntry = { path: field.slice(3) }
    if (/[RC]/.test(field.slice(0, 2))) {
      i++
      const orig = fields[i]
      if (orig !== undefined && orig !== '') entry.origPath = orig
    }
    out.push(entry)
  }
  return out
}

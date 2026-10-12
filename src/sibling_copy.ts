/** Name checks behind the Write pre-hook's sibling-copy advice (hooks_write.ts): which existing file a new file's name says it is a copy of, and which paths the advice never speaks about. Pure string work; the caller does the disk reads and the comparison. */

import { basename, dirname, extname, join } from 'node:path'

import { canQuoteArg, fencedCommand, quotedArg } from './hint_suggestion_guard.js'
import { displaySafePath } from './paths.js'

const BACKUP_EXTENSIONS = new Set(['.bak', '.orig', '.new'])

// `solver_v2`, `solver-v2`, `solverv2`: the part before `v<digits>` must end in a non-digit, so `v2` alone and `x1v2` style serial numbers are not read as versions of a shorter name.
const VERSIONED_STEM = /^(.*\D)[_.-]?v\d+$/i

const COPY_SUFFIX_STEM = /^(.+?)(?:[_.-](?:new|fixed|copy|old|orig|backup|bak)| copy| - copy| \(\d+\))$/i

/** Directory names whose files are numbered or variant by design, so a new file beside a sibling is expected there. */
const SERIES_DIRECTORIES = new Set(['migrations', 'versions', 'fixtures', '__snapshots__'])

const VERSION_DIRECTORY = /^v\d+$/i

/** Full paths of the existing files `filePath`'s name says it is a copy of, most specific first: `a/solver_v2.py` and `a/solver_fixed.py` name `a/solver.py`, `a/notes.md.bak` names `a/notes.md`. One suffix is stripped, so `solver_v2_fixed` names `solver_v2`. Nothing is read from disk; the caller checks which of them exist. */
export function siblingCandidates(filePath: string): string[] {
  const dir = dirname(filePath)
  const base = basename(filePath)
  const ext = extname(base)
  const stem = ext === '' ? base : base.slice(0, -ext.length)
  const names: string[] = []
  if (BACKUP_EXTENSIONS.has(ext.toLowerCase()) && extname(stem) !== '') names.push(stem)
  const versioned = VERSIONED_STEM.exec(stem)
  if (versioned !== null) names.push(versioned[1]!.replace(/[_.-]+$/, '') + ext)
  const copied = COPY_SUFFIX_STEM.exec(stem)
  if (copied !== null) names.push(copied[1]! + ext)
  return names.filter((name, i) => name !== '' && name !== ext && name !== base && names.indexOf(name) === i).map((name) => join(dir, name))
}

function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*'
      i++
    } else if (c === '*') {
      source += '[^/]*'
    } else if (c === '?') {
      source += '[^/]'
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp('(?:^|/)' + source + '$', 'i')
}

/** The directory names between `projectRoot` and the file, lowercased. A path outside the root, or no root at all, yields only the file's own directory, so a project that happens to live under a `v2` or `fixtures` folder is not silenced, while a file directly in one still is. */
function directorySegments(normalized: string, projectRoot: string | null): string[] {
  const root = projectRoot === null ? '' : projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root !== '' && normalized.toLowerCase().startsWith(root.toLowerCase() + '/')) return normalized.slice(root.length + 1).split('/').slice(0, -1).map((s) => s.toLowerCase())
  return normalized.split('/').slice(-2, -1).map((s) => s.toLowerCase())
}

/** Whether the advice stays silent for `filePath`: it sits, below `projectRoot`, in a directory of numbered or variant files by design (`migrations`, `versions`, `fixtures`, `__snapshots__`, any `vN` directory), or matches one of the user's `allow` globs. */
export function siblingCopyExcluded(filePath: string, allow: readonly string[], projectRoot: string | null): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  const segments = directorySegments(normalized, projectRoot)
  if (segments.some((s) => SERIES_DIRECTORIES.has(s) || VERSION_DIRECTORY.test(s))) return true
  return allow.some((glob) => glob !== '' && globToRegExp(glob.replace(/\\/g, '/')).test(normalized))
}

/** The advice for a new file that repeats `unchangedPct` percent of the existing `original`. The path is shown only inside a suggested command, quoted; a path no quote can hold leaves the command out. */
export function siblingCopyMessage(original: string, unchangedPct: number): string {
  const shown = displaySafePath(original)
  const outline = canQuoteArg(shown) ? `, or run ${fencedCommand('token-goat outline ' + quotedArg(shown))} to find the part to change` : ''
  return `This new file repeats about ${Math.round(unchangedPct)}% of an existing file in the same directory. Edit the original with \`Edit\` or \`token-goat replace\` instead of writing a second copy of it${outline}. If a separate copy is intended, carry on.`
}

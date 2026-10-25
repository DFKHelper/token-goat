/** Reading `git status --porcelain -z`, the unquoted NUL-separated listing of changed and untracked paths, and the argv of a `git` command line: the options git takes before its subcommand (`-C <path>`, `-c k=v`, `--git-dir`) and the directory a `-C` chain leaves git running in. */

import { shlexSplit } from './tool_filters/helpers.js'
import * as path from 'node:path'

/** One entry of `git status --porcelain -z`: the path as git names it, relative to the repository root, plus the path a rename or copy came from, and whether git reported it untracked (`??`). */
export interface PorcelainEntry {
  path: string
  origPath?: string
  untracked?: true
}

/** Parse `git status --porcelain -z` output. Each record is `XY path` ended by NUL, with no quoting, so a non-ASCII name or one holding ` -> ` comes through as written; a rename or copy (R or C in either column) is followed by one more NUL-ended field, the original path, which carries no status prefix. */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] {
  const fields = stdout.split('\x00')
  const out: PorcelainEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const entry: PorcelainEntry = { path: field.slice(3) }
    if (field.startsWith('??')) entry.untracked = true
    if (/[RC]/.test(field.slice(0, 2))) {
      i++
      const orig = fields[i]
      if (orig !== undefined && orig !== '') entry.origPath = orig
    }
    out.push(entry)
  }
  return out
}

/** Git's own leading options that take their value as the next argument, per git(1): `-C <path>`, `-c <name>=<value>`, and the long forms that also accept `--opt=<value>` (the `=` form is one token and needs no skip). */
export const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])

/** Tokenize a segment argv-style, or `null` when it is not tokenizable (shlexSplit throws on an unterminated quote). */
export function safeShlexSplit(segment: string): string[] | null {
  try {
    return shlexSplit(segment)
  } catch {
    return null
  }
}

/** Walks git's leading options from `start`, the index of the first token after `git`. Returns the index of the first token past them (the subcommand, when present) and the directory git runs in: each `-C <path>` moves it, relative to the one before it, and an empty path leaves it unchanged. */
export function skipGitLeadingOptions(tokens: readonly string[], start: number, runDir: string): { index: number; dir: string } {
  let dir = runDir
  let i = start
  for (; i < tokens.length && tokens[i]!.startsWith('-'); i++) {
    const t = tokens[i]!
    if (!GIT_OPTIONS_WITH_VALUE.has(t)) continue
    const value = tokens[++i]
    if (t === '-C' && value !== undefined && value !== '') dir = path.resolve(dir, value)
  }
  return { index: i, dir }
}

/**
 * Type definitions shared between the tree-sitter parser (Layer 7) and the
 * layers that query the index (index_reader, read commands).
 *
 * These mirror the row shapes of the `symbols`, `refs`, and `files` tables
 * defined in `db.ts`, plus the language-detection table used to decide which
 * tree-sitter grammar (later) or section parser (now) applies to a file.
 *
 * Pure types + one pure function: no I/O, no DB, no Node built-ins beyond the
 * path-extension lookup. Importable from any layer without side effects.
 */

import * as path from 'node:path'

/** One extracted definition: function, class, method, type, variable, etc. */
export interface SymbolEntry {
  readonly filePath: string
  readonly name: string
  readonly kind: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly body: string
  readonly docstring: string
}

/** One reference/usage of a name, with the surrounding line for context. */
export interface RefEntry {
  readonly filePath: string
  readonly name: string
  readonly line: number
  readonly col: number
  readonly context: string
}

/** One indexed source file: its SHA, mtime, language, and index timestamp. */
export interface FileIndexEntry {
  readonly filePath: string
  readonly sha: string
  readonly mtime: number
  readonly language: string
  readonly indexedAt: number
}

/** Languages token-goat can recognise. `unknown` is the catch-all fallback. */
export type Language =
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'rust'
  | 'go'
  | 'c'
  | 'cpp'
  | 'ruby'
  | 'java'
  | 'bash'
  | 'markdown'
  | 'toml'
  | 'json'
  | 'yaml'
  | 'css'
  | 'dockerfile'
  | 'csharp'
  | 'php'
  | 'html'
  | 'liquid'
  | 'kotlin'
  | 'graphql'
  | 'sql'
  | 'ini'
  | 'makefile'
  | 'proto'
  | 'env_file'
  | 'powershell'
  | 'unknown'

/**
 * Map of lowercase file extension (with leading dot) to {@link Language}.
 *
 * Multiple extensions can map to one language (`.mjs`/`.cjs` → javascript,
 * `.cc`/`.cxx`/`.hpp` → cpp). Anything not present falls through to `unknown`.
 */
const EXTENSION_LANGUAGE: ReadonlyMap<string, Language> = new Map([
  ['.py', 'python'],
  ['.pyi', 'python'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hxx', 'cpp'],
  ['.rb', 'ruby'],
  ['.ruby', 'ruby'],
  ['.java', 'java'],
  ['.sh', 'bash'],
  ['.bash', 'bash'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.toml', 'toml'],
  ['.json', 'json'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.css', 'css'],
  ['.scss', 'css'],
  ['.sass', 'css'],
  ['.less', 'css'],
  ['.cs', 'csharp'],
  ['.php', 'php'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.liquid', 'liquid'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.graphql', 'graphql'],
  ['.gql', 'graphql'],
  ['.sql', 'sql'],
  ['.ini', 'ini'],
  ['.cfg', 'ini'],
  ['.conf', 'ini'],
  ['.proto', 'proto'],
  ['.ps1', 'powershell'],
  ['.psm1', 'powershell'],
  ['.env', 'env_file'],
])

/**
 * Filenames (no extension or special name) that map directly to a language.
 *
 * Dockerfiles and lockfiles get classified by name; everything else relies on
 * the extension table. Compared case-insensitively against the basename.
 */
const FILENAME_LANGUAGE: ReadonlyMap<string, Language> = new Map([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['gnumakefile', 'makefile'],
  ['bsdmakefile', 'makefile'],
  ['cargo.toml', 'toml'],
  ['pyproject.toml', 'toml'],
  ['package.json', 'json'],
  ['tsconfig.json', 'json'],
  ['.env', 'env_file'],
  ['.env.local', 'env_file'],
  ['.env.example', 'env_file'],
  ['.env.sample', 'env_file'],
  ['.env.test', 'env_file'],
  ['.env.production', 'env_file'],
  ['.envrc', 'env_file'],
])

/**
 * Detect the {@link Language} of a file from its path.
 *
 * Checks the basename against {@link FILENAME_LANGUAGE} first (so `Dockerfile`
 * and named config files win), then falls back to the lowercased extension via
 * {@link EXTENSION_LANGUAGE}. Returns `'unknown'` when neither matches.
 */
export function detectLanguage(filePath: string): Language {
  const base = path.basename(filePath).toLowerCase()
  const byName = FILENAME_LANGUAGE.get(base)
  if (byName !== undefined) return byName

  const ext = path.extname(base).toLowerCase()
  return EXTENSION_LANGUAGE.get(ext) ?? 'unknown'
}

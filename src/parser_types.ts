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

/** One indexed source file: its SHA, mtime, language, index timestamp, and embedding freshness. */
export interface FileIndexEntry {
  readonly filePath: string
  readonly sha: string
  readonly mtime: number
  readonly language: string
  readonly indexedAt: number
  // The sha of the content that was last SUCCESSFULLY embedded, tracked separately from `sha`
  // (the last successfully PARSED content) so a worker crash or a thrown error mid-embedding
  // never gets masked by the parse-sha gate -- see makeIndexer in worker.ts. Empty string when
  // the file has never been embedded (or its last embedding attempt never completed).
  readonly embedSha: string
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
  | 'apex'
  | 'salesforce_metadata'
  | 'salesforce_markup'
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
  ['.cls', 'apex'],
  ['.trigger', 'apex'],
  ['.cmp', 'salesforce_markup'],
  ['.app', 'salesforce_markup'],
  ['.evt', 'salesforce_markup'],
  ['.intf', 'salesforce_markup'],
  ['.design', 'salesforce_markup'],
  ['.auradoc', 'salesforce_markup'],
  ['.tokens', 'salesforce_markup'],
  ['.page', 'salesforce_markup'],
  ['.component', 'salesforce_markup'],
  ['.email', 'salesforce_markup'],
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

  if (base.endsWith('-meta.xml')) {
    return 'salesforce_metadata'
  }

  const ext = path.extname(base).toLowerCase()
  return EXTENSION_LANGUAGE.get(ext) ?? 'unknown'
}

/**
 * Extensions for languages token-goat recognizes by name but has neither a tree-sitter
 * grammar nor a regex-fallback extractor for (see {@link NO_TREE_SITTER_EXTRACTORS} in
 * parser.ts). These are not part of the {@link Language} union -- detectLanguage() maps them
 * to `'unknown'` -- so a file in one of these languages indexes to zero symbols exactly like
 * a genuinely empty or unrecognized file, with nothing to tell the two apart. This map exists
 * purely to make that distinction visible in diagnostics (index/outline/skeleton), not to
 * change indexing behavior.
 */
export const UNSUPPORTED_LANGUAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['.swift', 'Swift'],
  ['.scala', 'Scala'],
  ['.sc', 'Scala'],
  ['.lua', 'Lua'],
  ['.ex', 'Elixir'],
  ['.exs', 'Elixir'],
  ['.dart', 'Dart'],
  ['.zig', 'Zig'],
  ['.r', 'R'],
])

/**
 * Returns a human-readable language name (e.g. `'Swift'`) if `filePath` is a recognized but
 * unsupported language -- one token-goat has no symbol extractor for at all -- so callers can
 * surface a distinct diagnostic instead of silently reporting "no symbols" indistinguishably
 * from an empty file. Returns `undefined` for anything else, including genuinely unrecognized
 * extensions and languages that do have an extractor.
 */
export function unsupportedLanguageName(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return UNSUPPORTED_LANGUAGE_EXTENSIONS.get(ext)
}

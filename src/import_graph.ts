/**
 * The project's internal import graph, built once and shared by every command that needs it.
 *
 * `runArch` grew this logic inline; `runAffected` needs the exact same graph walked in the
 * opposite direction. Copying it would have made a third relative-import resolver in this
 * repo -- there are already two, and they have measurably drifted: `runDeps`' resolver has a
 * comment conceding it under-resolves barrel imports (`./utils` backed by `./utils/index.ts`)
 * that `runArch`'s resolves correctly. A shared builder is how a fourth divergence is
 * prevented rather than merely regretted. `runDeps` keeps its own resolver for now: it answers
 * a different question (it reports unresolved specifiers verbatim rather than dropping them),
 * so folding it in is a behavior change, not an extraction.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { extractImports, importsExtensionFor } from './read_commands.js'
import { getTrackedFiles } from './repomap.js'
import { foldPath } from './util.js'

/**
 * Extensions probed when a relative specifier does not name an existing file outright.
 *
 * `.cjs`/`.cts` are present deliberately: an earlier version of this list omitted them, so a
 * relative import landing on a `.cjs`/`.cts` source resolved to nothing here while `runDeps`
 * resolved it fine.
 */
const DIRECT_PROBE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs', '.cts', '.py'] as const

/** Extensions probed for a directory specifier's `index.*` barrel file. */
const INDEX_PROBE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.mts', '.cts'] as const

export interface ImportGraph {
  /** Every git-tracked file considered, in `getTrackedFiles` order. */
  files: string[]
  /** file -> the project-internal files it imports. Every tracked file has an entry, possibly empty. */
  graph: Map<string, string[]>
  /** file -> the project-internal files that import it. Only files with at least one importer appear. */
  importedBy: Map<string, Set<string>>
  /** Resolve one relative specifier from one file to a tracked project file, or null if it leaves the project. */
  resolve: (fromFile: string, spec: string) => string | null
}

/**
 * Build the internal import graph for `cwd`.
 *
 * Only *relative* specifiers become edges: a bare specifier (`react`, `node:fs`) is external by
 * definition and has no tracked file to point at. A file that cannot be read is skipped rather
 * than aborting the build -- one unreadable file must not erase the whole graph.
 */
export function buildImportGraph(cwd: string): ImportGraph {
  const files = getTrackedFiles(cwd)

  // Case-insensitive filesystems (Windows/macOS) treat Foo.ts and foo.ts as the same file, and an
  // import specifier's casing need not match the tracked path's, so membership is checked through
  // foldPath() rather than raw string equality.
  const filesByFoldedPath = new Map<string, string>()
  for (const f of files) filesByFoldedPath.set(foldPath(f), f)

  const resolve = (fromFile: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const dir = path.dirname(fromFile)
    // Strip .js/.mjs/.cjs output extensions so a NodeNext/ESM specifier written against the
    // compiled output ("./foo.js") still probes its TypeScript source ("./foo.ts").
    const strippedSpec = spec.replace(/\.(m?js|cjs)$/, '')
    const base = path.resolve(dir, strippedSpec)
    for (const ext of DIRECT_PROBE_EXTENSIONS) {
      const match = filesByFoldedPath.get(foldPath(base + ext))
      if (match !== undefined) return match
    }
    // A specifier naming a directory (a barrel import) never matches the probes above, which only
    // append an extension to the directory's own path and never look inside it.
    const idx = path.join(base, 'index')
    for (const ext of INDEX_PROBE_EXTENSIONS) {
      const match = filesByFoldedPath.get(foldPath(idx + ext))
      if (match !== undefined) return match
    }
    return null
  }

  const graph = new Map<string, string[]>()
  const importedBy = new Map<string, Set<string>>()

  for (const file of files) {
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const internal: string[] = []
    for (const spec of extractImports(text, importsExtensionFor(file))) {
      const resolved = resolve(file, spec)
      if (resolved === null) continue
      internal.push(resolved)
      let importers = importedBy.get(resolved)
      if (importers === undefined) {
        importers = new Set()
        importedBy.set(resolved, importers)
      }
      importers.add(file)
    }
    graph.set(file, internal)
  }

  return { files, graph, importedBy, resolve }
}

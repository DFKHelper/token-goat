/**
 * Resolves, out of `package-lock.json` alone, the set of packages an ordinary consumer install
 * would land on disk -- with no network and no `npm install`.
 *
 * SECURITY.md states how large an install of token-goat is, in two configurations. Numbers like
 * that go stale silently, and the guard that watched them used to watch the wrong thing: it
 * asserted that the literal text `clean, 106 packages` appeared in the document, which is a fact
 * about the sentence rather than about the tree, and stayed green while the count drifted. This
 * exists so the guard can compare the document against a measurement instead.
 *
 * The walk is npm's own resolution, run over the lock's `packages` map. Its keys are installed
 * paths, so a dependency is resolved the way node resolves it -- look for
 * `<path>/node_modules/<name>`, then walk up the path chain -- and the set of paths reached is the
 * set of directories that would exist. Counting paths rather than distinct names is deliberate: two
 * copies of one package at different versions are two directories, and that is the unit SECURITY.md
 * counts in (a distinct-name count of the same tree gives 101 and 39 where the real install gives
 * 106 and 40).
 *
 * Two things this deliberately is not.
 *
 * It is not platform-agnostic. The lock lists a prebuilt binary for every platform sharp,
 * `@napi-rs/canvas` and `sqlite-vec` support, and an install takes only the matching one -- 34 to 38
 * of them are skipped depending on where you stand, which is most of the difference between a naive
 * lock count and a real install. So `os`/`cpu` filtering is applied exactly as npm applies it, and
 * the answer for the optional-inclusive tree is a per-platform answer (measured: 102 on win32/x64,
 * 106 on linux/x64, 103 on darwin/arm64). The tree without optional packages contains no
 * platform-gated entry at all and is the same 40 everywhere.
 *
 * It is not an upper bound. The lock pins versions that were current when it was last built; a
 * fresh install resolves the same ranges to whatever is newest that day, and other people's trees
 * grow. So a real install is this number or larger, never smaller, and the guard compares in that
 * direction rather than pretending this is the whole answer.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface LockEntry {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  os?: string[]
  cpu?: string[]
}

export interface ConsumerTreeOptions {
  /** Whether to follow optional edges, i.e. a plain `npm install` rather than `--omit=optional`. */
  includeOptional: boolean
  /** Defaults to where the test is running, which is what makes the count reproducible on each CI runner. */
  os?: string
  cpu?: string
  lockPath?: string
}

/** npm's own rule: a bare entry matches everything, `!x` excludes, anything else is an allow-list. */
function platformMatches(declared: string[] | undefined, actual: string): boolean {
  if (!Array.isArray(declared) || declared.length === 0) return true
  return declared.some((value) => (value.startsWith('!') ? value.slice(1) !== actual : value === actual))
}

/**
 * The paths a consumer install would create, as lock keys (`node_modules/x`, `node_modules/x/node_modules/y`).
 * The root project is not among them; callers that want the count as SECURITY.md states it add one
 * for token-goat itself.
 */
export function consumerTree(options: ConsumerTreeOptions): Set<string> {
  const os = options.os ?? process.platform
  const cpu = options.cpu ?? process.arch
  const lock = JSON.parse(
    fs.readFileSync(options.lockPath ?? path.join(repoRoot, 'package-lock.json'), 'utf8'),
  ) as { packages: Record<string, LockEntry> }
  const packages = lock.packages
  const root = packages['']
  if (!root) throw new Error('package-lock.json has no root entry; it is not a v2/v3 lockfile')

  const resolveFrom = (fromPath: string, name: string): string | null => {
    let base = fromPath
    for (;;) {
      const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`
      if (packages[candidate]) return candidate
      if (base === '') return null
      const cut = base.lastIndexOf('/node_modules/')
      base = cut === -1 ? '' : base.slice(0, cut)
    }
  }

  const edgesOf = (entry: LockEntry): string[] => {
    const names = new Set<string>(Object.keys(entry.dependencies ?? {}))
    if (options.includeOptional) for (const n of Object.keys(entry.optionalDependencies ?? {})) names.add(n)
    for (const n of Object.keys(entry.peerDependencies ?? {})) {
      // An optional peer is an optional edge, so it belongs to the same half of the tree as one.
      if (entry.peerDependenciesMeta?.[n]?.optional && !options.includeOptional) continue
      names.add(n)
    }
    return [...names]
  }

  const reached = new Set<string>()
  // devDependencies are never seeded: nobody installing token-goat gets them.
  const frontier: [string, string][] = edgesOf(root).map((name) => ['', name])
  while (frontier.length) {
    const next = frontier.pop()
    if (!next) break
    const [from, name] = next
    const at = resolveFrom(from, name)
    if (!at || reached.has(at)) continue
    const entry = packages[at]
    // npm skips a package whose os/cpu excludes the machine, and does not descend into it either.
    if (!platformMatches(entry.os, os) || !platformMatches(entry.cpu, cpu)) continue
    reached.add(at)
    for (const edge of edgesOf(entry)) frontier.push([at, edge])
  }
  return reached
}

/** The count in the unit SECURITY.md uses: installed package directories, token-goat included. */
export function consumerPackageCount(options: ConsumerTreeOptions): number {
  return consumerTree(options).size + 1
}

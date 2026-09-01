/**
 * Module detection over the project's internal import graph.
 *
 * `arch` already answers three local questions -- which files are imported most, which are
 * imported by nobody, which import each other in a cycle. None of them says what the project is
 * made *of*: which files form a cohesive group that mostly talks to itself, and where one group
 * reaches across into another. That is the question worth asking before a refactor, and it is a
 * property of the whole graph rather than of any one file, so no per-file metric produces it.
 *
 * The grouping is computed by greedy modularity optimisation (the Louvain method): every file
 * starts alone, each is repeatedly moved into whichever neighbouring group most increases the
 * partition's modularity, then each group is collapsed into a single node and the pass repeats on
 * the smaller graph until no move helps. It reads only the graph `buildImportGraph` already
 * builds, costs no model tokens, and touches no index.
 *
 * Two properties this file spends real effort on, because without them the output is worse than
 * nothing:
 *
 *   - It is deterministic. The algorithm's result depends on the order nodes are visited and on
 *     how ties are broken, and the natural implementation inherits both from hash-map iteration
 *     order. Two runs on one unchanged repo would then disagree about what the project is made
 *     of, which is not a finding a reader can act on. So node order is fixed by codepoint-sorted
 *     path (never `localeCompare`, whose collation varies by machine), candidate groups are
 *     always visited in ascending numeric order, and a tie in modularity gain keeps the incumbent.
 *
 *   - It reports how strong the split is. Greedy modularity optimisation always returns a
 *     partition -- run it on a random graph and it hands back groups that look exactly like real
 *     ones. Modularity is the number that separates the two cases, so it is reported alongside
 *     every result rather than kept internal, and a weak split is named as weak instead of being
 *     presented as structure.
 */
import type { ImportGraph } from './import_graph.js'
import { toDisplayPath } from './paths.js'
import { getDisplayRoot } from './project.js'
import { countNoun } from './util.js'

/**
 * Below this, the grouping is reported as weak.
 *
 * Modularity measures how much more edge weight falls inside groups than a degree-preserving
 * random graph would put there: 0 means the split explains nothing the degree sequence did not
 * already, and the maximum approaches 1. This threshold is the conventional dividing line in the
 * community-detection literature for "there is probably real structure here" -- it is a rule of
 * thumb, not a proof, which is why the number itself is always printed next to the verdict rather
 * than replaced by it.
 */
export const WEAK_MODULARITY = 0.3

/** Guarantees termination if a pathological graph keeps producing improving moves. Real graphs
 * converge in a handful of passes; this is a backstop, not a tuning knob. */
const MAX_PASSES = 32

/** Float noise must not decide a move, or the same repo groups differently on two machines. */
const GAIN_EPSILON = 1e-12

export interface DetectedModule {
  /** 1-based rank by size, used to name this module in the cross-import list. */
  index: number
  /**
   * The module's most-connected member: the file the rest of the group is built around, and the
   * name the module goes by everywhere it is referenced.
   *
   * Not a shared directory prefix, which was tried first and does not work: a module normally
   * holds both a source file and the test that imports it, those sit in different trees, and the
   * longest common prefix of `src/` and `tests/` is the repository root. Measured on this project,
   * every one of the fifteen modules came back labelled `.` -- fifteen rows naming nothing, over a
   * cross-import list reading `. -> .`.
   */
  core: string
  /** Directory every member shares, or null when they span more than one. Present when the module
   * genuinely is a directory; absent is the more interesting case. */
  commonDir: string | null
  /** Member files, root-relative, sorted. */
  files: string[]
  size: number
  /** How many distinct directories the members sit in. More than one means the module does not
   * line up with the directory layout, which is itself the finding. */
  directories: number
}

export interface CrossModuleImport {
  fromIndex: number
  toIndex: number
  fromCore: string
  toCore: string
  /** Directed import edges crossing from one module into the other. */
  imports: number
}

export interface ModuleResult {
  modules: DetectedModule[]
  /** Before `--top` sliced. */
  modulesTotal: number
  /** Newman-Girvan modularity of the full partition, or null when the graph has no edges at all
   * and modularity is undefined rather than zero. */
  modularity: number | null
  /** Files with no internal imports in either direction. They are in no module because they are
   * connected to nothing, which is not the same as a module of one. */
  isolatedCount: number
  crossImports: CrossModuleImport[]
  crossImportsTotal: number
  /** True when the graph has files but no internal import edges, so nothing could be grouped.
   * Distinguished from a real zero because "0 modules" over an edgeless graph reads as a finding
   * about the architecture when it is a statement about the input. */
  noEdges: boolean
}

/** An undirected weighted graph over integer node ids, with self-loops allowed. */
interface WeightedGraph {
  n: number
  /** `adj[i]` maps neighbour id to edge weight. A self-loop is stored as `adj[i][i]`. */
  adj: Map<number, number>[]
  /** Sum of incident edge weights, with a self-loop counted twice. */
  degree: number[]
  /** Total edge weight: every undirected edge once, every self-loop once. */
  m: number
}

function emptyGraph(n: number): WeightedGraph {
  return { n, adj: Array.from({ length: n }, () => new Map<number, number>()), degree: new Array<number>(n).fill(0), m: 0 }
}

function addEdge(g: WeightedGraph, a: number, b: number, w: number): void {
  if (a === b) {
    g.adj[a]!.set(a, (g.adj[a]!.get(a) ?? 0) + w)
    g.degree[a]! += 2 * w
  } else {
    g.adj[a]!.set(b, (g.adj[a]!.get(b) ?? 0) + w)
    g.adj[b]!.set(a, (g.adj[b]!.get(a) ?? 0) + w)
    g.degree[a]! += w
    g.degree[b]! += w
  }
  g.m += w
}

/**
 * One Louvain local-moving pass: move nodes between communities while modularity improves.
 *
 * Returns the per-node community assignment and whether any node ever moved. Nodes are visited in
 * ascending id order and candidate communities in ascending id order, with a strictly-greater
 * comparison, so the incumbent wins every tie and the whole pass is reproducible.
 */
function localMoving(g: WeightedGraph): { community: number[]; moved: boolean } {
  const community = Array.from({ length: g.n }, (_, i) => i)
  // Total degree of each community, and the running assignment's bookkeeping.
  const tot = g.degree.slice()
  const twoM = 2 * g.m
  let movedEver = false
  if (twoM === 0) return { community, moved: false }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false
    for (let i = 0; i < g.n; i++) {
      const ki = g.degree[i]!
      const ci = community[i]!

      // Edge weight from i into each neighbouring community, self-loop excluded: a self-loop is
      // internal to i wherever i goes, so it shifts every candidate's gain by the same amount and
      // cannot change which one wins.
      const links = new Map<number, number>()
      for (const [j, w] of g.adj[i]!) {
        if (j === i) continue
        const cj = community[j]!
        links.set(cj, (links.get(cj) ?? 0) + w)
      }

      // Remove i from its community before scoring, so the incumbent is judged on the same terms
      // as every challenger rather than against a total that still includes i's own degree.
      tot[ci] = tot[ci]! - ki
      let bestC = ci
      let bestGain = (links.get(ci) ?? 0) - (tot[ci]! * ki) / twoM

      // Sorted, so accumulation order and therefore the floating-point comparison sequence is the
      // same on every run and every machine.
      for (const c of [...links.keys()].sort((a, b) => a - b)) {
        if (c === ci) continue
        const gain = links.get(c)! - (tot[c]! * ki) / twoM
        if (gain > bestGain + GAIN_EPSILON) {
          bestGain = gain
          bestC = c
        }
      }

      tot[bestC] = tot[bestC]! + ki
      community[i] = bestC
      if (bestC !== ci) {
        improved = true
        movedEver = true
      }
    }
    if (!improved) break
  }

  return { community, moved: movedEver }
}

/**
 * Renumber an assignment to a dense 0..k-1 range, ordered by each community's smallest member, so
 * the aggregate graph built from it has stable ids across runs.
 */
function densify(community: readonly number[]): { dense: number[]; count: number } {
  const firstMember = new Map<number, number>()
  for (let i = 0; i < community.length; i++) {
    const c = community[i]!
    if (!firstMember.has(c)) firstMember.set(c, i)
  }
  const ordered = [...firstMember.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c)
  const remap = new Map<number, number>()
  ordered.forEach((c, idx) => remap.set(c, idx))
  return { dense: community.map((c) => remap.get(c)!), count: ordered.length }
}

/** Newman-Girvan modularity of `partition` on `g`. Null when the graph carries no edge weight,
 * where the quantity is undefined rather than zero. */
function modularityOf(g: WeightedGraph, partition: readonly number[]): number | null {
  const twoM = 2 * g.m
  if (twoM === 0) return null
  const internal = new Map<number, number>()
  const tot = new Map<number, number>()
  for (let i = 0; i < g.n; i++) {
    const ci = partition[i]!
    tot.set(ci, (tot.get(ci) ?? 0) + g.degree[i]!)
    for (const [j, w] of g.adj[i]!) {
      // Each undirected edge appears in both endpoints' maps, so counting only j >= i visits it
      // once; a self-loop (j === i) is visited once by the same rule.
      if (j < i) continue
      if (partition[j]! === ci) internal.set(ci, (internal.get(ci) ?? 0) + w)
    }
  }
  let q = 0
  for (const [c, t] of tot) {
    q += (2 * (internal.get(c) ?? 0)) / twoM - (t / twoM) ** 2
  }
  return q
}

/** Full Louvain: local moving, then collapse and repeat until a pass moves nothing. */
function louvain(g: WeightedGraph): number[] {
  let current = g
  // Maps each original node to its community in the current (possibly aggregated) graph.
  let mapping = Array.from({ length: g.n }, (_, i) => i)

  for (let level = 0; level < MAX_PASSES; level++) {
    const { community, moved } = localMoving(current)
    const { dense, count } = densify(community)
    mapping = mapping.map((c) => dense[c]!)
    if (!moved || count === current.n) break

    const next = emptyGraph(count)
    for (let i = 0; i < current.n; i++) {
      for (const [j, w] of current.adj[i]!) {
        if (j < i) continue
        // A within-community edge becomes a self-loop on the collapsed node, which is what keeps
        // the collapsed graph's modularity equal to the original's under the same partition.
        addEdge(next, dense[i]!, dense[j]!, w)
      }
    }
    current = next
  }
  return mapping
}

/**
 * Directory shared by every file, or null when they span more than one tree.
 *
 * Two cases produce an empty common *prefix* and mean opposite things: every member sitting in the
 * repository root (they do share a directory -- that one), and members split across `src/` and
 * `tests/` (they share nothing tighter than the whole project). Checking the distinct-directory
 * set first separates them; a bare prefix check reports the first case as "no shared directory".
 */
function commonDirLabel(files: readonly string[]): string | null {
  const dirs = new Set(files.map(dirOf))
  // Trailing slash on a real directory, so the single-directory case and the shared-prefix case
  // below render identically rather than as `pkg` beside `src/`. The root keeps its bare `.`,
  // which the caller renders as words.
  if (dirs.size === 1) {
    const only = [...dirs][0]!
    return only === '.' ? '.' : `${only}/`
  }
  const segmentLists = files.map((f) => {
    const parts = f.split('/')
    parts.pop()
    return parts
  })
  const first = segmentLists[0]
  if (first === undefined) return null
  const prefix: string[] = []
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]!
    if (!segmentLists.every((s) => s[i] === seg)) break
    prefix.push(seg)
  }
  return prefix.length === 0 ? null : `${prefix.join('/')}/`
}

function dirOf(file: string): string {
  const idx = file.lastIndexOf('/')
  return idx === -1 ? '.' : file.slice(0, idx)
}

/**
 * Group the import graph into modules.
 *
 * `top` caps how many modules and cross-import pairs are returned; the untruncated totals come
 * back alongside so a caller can say the cap bit.
 */
export function detectModules(imports: ImportGraph, cwd: string, top: number): ModuleResult {
  // `importedBy` is deliberately unused: iterating `graph`'s forward edges already visits every
  // edge once and bumps both of its endpoints, so reading the reverse map too would double-count.
  const { files, graph } = imports
  const root = getDisplayRoot(cwd)

  // Undirected projection. Direction is what `hubs` and `entry points` already report; cohesion is
  // direction-free, so an import in either direction is one unit of coupling and a mutual import
  // is two.
  const degreeOf = new Map<string, number>()
  const bump = (f: string): void => {
    degreeOf.set(f, (degreeOf.get(f) ?? 0) + 1)
  }
  for (const [from, targets] of graph) {
    for (const to of targets) {
      if (from === to) continue
      bump(from)
      bump(to)
    }
  }

  // Isolated files are dropped before grouping rather than becoming singleton communities. On a
  // real project they are the majority -- every file that neither imports nor is imported -- and
  // left in they would swamp the module count and drag modularity toward a number that describes
  // the isolates rather than the structure. Their count is reported instead.
  const connected = files.filter((f) => (degreeOf.get(f) ?? 0) > 0)
  const isolatedCount = files.length - connected.length

  if (connected.length === 0) {
    return { modules: [], modulesTotal: 0, modularity: null, isolatedCount, crossImports: [], crossImportsTotal: 0, noEdges: true }
  }

  // Codepoint order, not `localeCompare`: collation differs between machines and would make the
  // visit order -- and therefore the grouping -- machine-dependent.
  const ordered = [...connected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const idOf = new Map<string, number>()
  ordered.forEach((f, i) => idOf.set(f, i))

  const g = emptyGraph(ordered.length)
  // Accumulate into a pair map first so a mutual import lands as one weight-2 edge rather than two
  // separate additions whose order could vary.
  const pairWeight = new Map<string, number>()
  for (const [from, targets] of graph) {
    const a = idOf.get(from)
    if (a === undefined) continue
    for (const to of targets) {
      const b = idOf.get(to)
      if (b === undefined || a === b) continue
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1)
    }
  }
  for (const key of [...pairWeight.keys()].sort()) {
    const [a, b] = key.split(':').map(Number) as [number, number]
    addEdge(g, a, b, pairWeight.get(key)!)
  }

  const partition = louvain(g)
  const modularity = modularityOf(g, partition)

  const membersOf = new Map<number, string[]>()
  for (let i = 0; i < ordered.length; i++) {
    const c = partition[i]!
    const list = membersOf.get(c)
    if (list === undefined) membersOf.set(c, [ordered[i]!])
    else list.push(ordered[i]!)
  }

  // The core is the member with the most edges to other members of its own module -- deliberately
  // in-module degree rather than project-wide degree, because a file that half the project imports
  // would otherwise name whichever module it happened to land in while telling you nothing about
  // that module's own shape.
  const inModuleDegree = new Map<string, number>()
  for (const [from, targets] of graph) {
    const a = idOf.get(from)
    if (a === undefined) continue
    for (const to of targets) {
      const b = idOf.get(to)
      if (b === undefined || a === b || partition[a]! !== partition[b]!) continue
      inModuleDegree.set(from, (inModuleDegree.get(from) ?? 0) + 1)
      inModuleDegree.set(to, (inModuleDegree.get(to) ?? 0) + 1)
    }
  }

  // Largest first; ties by core then by first member, so ordering never depends on map insertion.
  const built = [...membersOf.entries()]
    .map(([c, absFiles]) => {
      const display = absFiles.map((f) => toDisplayPath(root, f)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      // Ties broken by path, so a module whose members are all equally connected still gets one
      // stable name rather than a different one each run.
      const coreAbs = [...absFiles].sort((a, b) => (inModuleDegree.get(b) ?? 0) - (inModuleDegree.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))[0]!
      return { community: c, core: toDisplayPath(root, coreAbs), commonDir: commonDirLabel(display), files: display, directories: new Set(display.map(dirOf)).size }
    })
    .sort((a, b) => b.files.length - a.files.length || (a.core < b.core ? -1 : a.core > b.core ? 1 : 0) || (a.files[0]! < b.files[0]! ? -1 : 1))

  const indexOfCommunity = new Map<number, number>()
  built.forEach((m, i) => indexOfCommunity.set(m.community, i + 1))
  const coreOfIndex = new Map<number, string>()
  built.forEach((m, i) => coreOfIndex.set(i + 1, m.core))

  // Cross-module coupling is read off the *directed* graph: "which module reaches into which" is a
  // direction-carrying question even though the grouping that produced the modules is not.
  const crossCount = new Map<string, number>()
  for (const [from, targets] of graph) {
    const a = idOf.get(from)
    if (a === undefined) continue
    const ca = indexOfCommunity.get(partition[a]!)
    if (ca === undefined) continue
    for (const to of targets) {
      const b = idOf.get(to)
      if (b === undefined) continue
      const cb = indexOfCommunity.get(partition[b]!)
      if (cb === undefined || ca === cb) continue
      const key = `${ca}:${cb}`
      crossCount.set(key, (crossCount.get(key) ?? 0) + 1)
    }
  }
  const allCross: CrossModuleImport[] = [...crossCount.entries()]
    .map(([key, imports]) => {
      const [fromIndex, toIndex] = key.split(':').map(Number) as [number, number]
      return { fromIndex, toIndex, fromCore: coreOfIndex.get(fromIndex)!, toCore: coreOfIndex.get(toIndex)!, imports }
    })
    .sort((a, b) => b.imports - a.imports || a.fromIndex - b.fromIndex || a.toIndex - b.toIndex)

  const modules: DetectedModule[] = built.slice(0, top).map((m, i) => ({ index: i + 1, core: m.core, commonDir: m.commonDir, files: m.files, size: m.files.length, directories: m.directories }))

  return {
    modules,
    modulesTotal: built.length,
    modularity,
    isolatedCount,
    crossImports: allCross.slice(0, top),
    crossImportsTotal: allCross.length,
    noEdges: false,
  }
}

/**
 * Text rendering of a {@link ModuleResult}, as the lines `arch` appends under its own sections.
 *
 * Every way this can show less than it found says so on its own line: the module cap, the
 * cross-import cap, the files left out of every module, and -- the one that matters most -- a
 * modularity too low for the grouping to mean anything, which is the case where the output looks
 * most like a real finding and is least likely to be one.
 */
export function renderModules(result: ModuleResult, top: number): string[] {
  const lines: string[] = []
  if (result.noEdges) {
    lines.push(`modules: none. No file in this project imports another by a relative path, so there is nothing to group (${countNoun(result.isolatedCount, 'file')} checked).`)
    return lines
  }

  const q = result.modularity
  const strength = q === null ? '' : q < WEAK_MODULARITY ? `, modularity ${q.toFixed(2)} -- weak, so treat this grouping as a hint rather than a finding` : `, modularity ${q.toFixed(2)}`
  lines.push(result.modules.length < result.modulesTotal ? `modules (top ${result.modules.length} of ${result.modulesTotal}${strength}):` : `modules (${result.modulesTotal} found${strength}):`)
  for (const m of result.modules) {
    // The directory span is the second half of the finding: a module that is exactly one directory
    // is the layout you already have, and one spread across several is the part worth looking at.
    const where = m.commonDir === null ? `across ${m.directories} directories` : m.commonDir === '.' ? 'all in the repository root' : `all in ${m.commonDir}`
    lines.push(`  #${m.index} ${m.size} files\t${m.core}\t(${where})`)
  }
  if (result.isolatedCount > 0) {
    lines.push(`  ${result.isolatedCount} files are in no module (they neither import nor are imported within the project).`)
  }

  if (result.crossImportsTotal === 0) {
    lines.push('cross-module imports: none. Every import stays inside its own module.')
  } else {
    lines.push(
      result.crossImports.length < result.crossImportsTotal
        ? `cross-module imports (top ${result.crossImports.length} of ${result.crossImportsTotal} pairs):`
        : `cross-module imports (${result.crossImportsTotal} pairs):`,
    )
    for (const c of result.crossImports) {
      lines.push(`  ${c.imports} imports\t#${c.fromIndex} ${c.fromCore} -> #${c.toIndex} ${c.toCore}`)
    }
  }
  // A cross-import pair naming a module the --top cut leaves a dangling `#12` with no entry above
  // it. Say which modules are addressable rather than letting the reader hunt for a row that was
  // never printed.
  if (result.modules.length < result.modulesTotal && result.crossImports.some((c) => c.fromIndex > top || c.toIndex > top)) {
    lines.push(`  (a #N above ${top} refers to a module the --top cap left out; raise --top to see it.)`)
  }
  return lines
}

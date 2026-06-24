/**
 * Line-level output filters applied during bash output compression.
 *
 * The full Python token-goat ships per-tool filter classes (pytest, jest,
 * cargo, webpack, …) that understand each tool's output structure. This TS
 * layer ports the universal, line-by-line noise filters that apply regardless
 * of which tool produced the output: progress chatter, download spinners,
 * package-manager bookkeeping, and similar lines a human would skim past.
 *
 * Each {@link Filter} inspects one line and either returns a replacement
 * string, returns the line unchanged, or returns `null` to drop it entirely.
 * `compressOutput` (bash_compress.ts) runs every filter in order over each
 * line; the first filter whose `pattern` matches gets to transform the line.
 *
 * Pure module: no I/O, no state. Regexes are anchored to whole-line semantics
 * where it matters so they never match a substring of legitimate output.
 */

/**
 * A single output filter.
 *
 * `pattern` is the trigger: when non-null and it matches a line, `replacer`
 * decides the outcome. A `null` pattern means the filter is unconditional and
 * `replacer` is consulted for every line (used for transforms that inspect the
 * line themselves). `replacer` returns the (possibly rewritten) line, or `null`
 * to remove the line from the output entirely.
 */
export interface Filter {
  readonly name: string
  readonly pattern: RegExp | null
  readonly replacer: (line: string) => string | null
}

/** Drop the line outright. */
const DROP = (): null => null

/**
 * The ordered filter chain.
 *
 * Order matters: more specific patterns precede general ones so a git-progress
 * line is claimed by `git-progress` rather than a broader percentage filter.
 * Every filter only fires when its `pattern` matches, so non-matching normal
 * output flows through untouched.
 */
export const FILTERS: readonly Filter[] = [
  {
    // git fetch/clone progress: "remote: Counting objects:  73% (8/11)",
    // "Receiving objects: 100% (11/11), done.", "Resolving deltas: ...".
    name: 'git-progress',
    pattern:
      /^(remote:\s+)?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Unpacking objects|Enumerating objects|Writing objects):/i,
    replacer: DROP,
  },
  {
    // npm install summary chatter: "added 142 packages in 3s",
    // "changed 5 packages", "audited 200 packages in 1s".
    name: 'npm-summary',
    pattern: /^\s*(added|removed|changed|audited)\s+\d+\s+packages?\b/i,
    replacer: DROP,
  },
  {
    // npm/yarn deprecation + funding noise that adds nothing actionable.
    name: 'npm-funding',
    pattern: /^\s*\d+\s+packages? are looking for funding\b/i,
    replacer: DROP,
  },
  {
    // pip download progress: "Downloading foo-1.2.3-py3-none-any.whl (1.2 MB)"
    // and the "  |████████| 1.2 MB 5.0 MB/s" meter lines.
    name: 'pip-download',
    pattern: /^\s*(Downloading|Collecting|Using cached|Requirement already satisfied)\b/i,
    replacer: DROP,
  },
  {
    // A progress meter line built from Unicode box-drawing/block glyphs, e.g.
    // "████████░░░░ 60%". Restricted to those glyphs (not ASCII #/=/-) so an
    // ASCII final state like "Building [####] 100%" is preserved as real output.
    name: 'progress-bar',
    pattern: /[█▉▊▋▌▍▎▏▓▒░]{3,}/,
    replacer: DROP,
  },
  {
    // Docker layer pull progress: "abc123: Pulling fs layer",
    // "abc123: Download complete", "abc123: Pull complete".
    name: 'docker-pull',
    pattern: /^[0-9a-f]{6,}:\s+(Pulling|Waiting|Downloading|Verifying|Extracting|Download complete|Pull complete|Already exists)\b/i,
    replacer: DROP,
  },
  {
    // cargo build chatter: "   Compiling foo v0.1.0", "  Downloading crates ...".
    name: 'cargo-progress',
    pattern: /^\s*(Compiling|Downloading|Downloaded|Updating|Fetching)\s+\S/,
    replacer: DROP,
  },
  {
    // Webpack/bundler asset rows are voluminous; keep the build result lines
    // (errors, warnings, "compiled") by only dropping plain asset size rows.
    name: 'webpack-asset',
    pattern: /^\s*(asset|chunk)\s+\S+\s+[\d.]+\s*(KiB|MiB|bytes)\b/i,
    replacer: DROP,
  },
  {
    // A binary-content marker line: any line carrying a NUL byte is treated as
    // non-text and collapsed to a single readable marker.
    name: 'binary-content',
    // eslint-disable-next-line no-control-regex -- intentionally matches the NUL control byte that signals binary content
    pattern: /\x00/,
    replacer: () => '[binary content elided by token-goat]',
  },
]

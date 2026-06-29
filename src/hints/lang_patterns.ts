/**
 * Language-agnostic pattern table for read suppression and recall hints.
 *
 * Centralises the file-type knowledge used by the pre_read and pre_bash hooks
 * to block wasteful reads of lock files, build artifacts, and generated output,
 * and to suggest surgical alternatives.
 */

/**
 * Lock file basenames (lowercased for case-insensitive comparison).
 *
 * These files are machine-generated and rarely useful to read in full.
 * pre_read denies them and suggests `token-goat section` instead.
 */
const LOCK_FILE_NAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'gemfile.lock',
  'go.sum',
  'composer.lock',
  'mix.lock',
  'pubspec.lock',
  'package.resolved',
])

/**
 * Manifest / config file basenames (lowercased).
 *
 * On re-read, pre_read emits a hint suggesting `token-goat section` or
 * `token-goat config-get` to extract a specific field.
 */
const MANIFEST_FILE_NAMES: ReadonlySet<string> = new Set([
  'package.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'go.work',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'composer.json',
  'gemfile',
  'mix.exs',
  'pubspec.yaml',
  'cmakelists.txt',
  'makefile',
  'project.clj',
  // TypeScript / JavaScript project configs
  'tsconfig.json',
  'jsconfig.json',
  // Bundler / framework configs
  'vite.config.ts',
  'vite.config.js',
  'webpack.config.js',
  'webpack.config.ts',
  'rollup.config.js',
  'rollup.config.ts',
  'esbuild.config.js',
  'next.config.js',
  'next.config.ts',
  'nuxt.config.ts',
])

/**
 * Glob suffixes that identify manifest files by extension (lowercased).
 * Used in addition to MANIFEST_FILE_NAMES for *.cabal files.
 */
const MANIFEST_EXTENSIONS: ReadonlySet<string> = new Set([
  '.cabal',
])

/**
 * Regex patterns for manifest files that cannot be expressed as exact
 * basename matches (e.g. `tsconfig.*.json`).
 */
const MANIFEST_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^tsconfig(\..+)?\.json$/i,
]

/**
 * Build output directory segment names (lowercased).
 *
 * pre_read denies any path whose segments contain one of these names.
 * node_modules is already handled in hooks_read.ts — excluded here to
 * avoid a duplicate deny with a different message.
 */
const BUILD_DIR_NAMES: ReadonlySet<string> = new Set([
  'dist',
  'target',
  'build',
  'out',
  '__pycache__',
  '.next',
  '.nuxt',
  '.output',
  '.gradle',
  '_build',
  '.build',
  'pkg',
  'obj',
])

/**
 * Extensions that are always generated and never useful to read.
 *
 * Note: .map (source maps) and .d.ts (type declarations) are only generated
 * inside build/dist dirs; they are handled by isGeneratedFile() rather than
 * by an unconditional extension check.
 */
const ALWAYS_GENERATED_EXTS: ReadonlySet<string> = new Set([
  '.pyc',
  '.pyo',
  '.pyd',
  '.class',
  '.o',
  '.a',
  '.so',
  '.dylib',
  '.dll',
  '.tsbuildinfo',
])

/**
 * Extensions that are generated only when inside a build/dist directory.
 */
const CONDITIONALLY_GENERATED_EXTS: ReadonlySet<string> = new Set([
  '.map',
  '.d.ts',
])

/**
 * Regex patterns for build tool bash commands whose output is worth caching.
 *
 * When a command matching one of these was already run and its output is
 * cached, the pre_bash hook injects a recall hint instead of letting the
 * command run again.
 */
export const BUILD_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  // Rust / Cargo
  /^\s*cargo\s+(build|test|run|check|clippy)\b/i,
  // Go
  /^\s*go\s+(build|test|run|vet)\b/i,
  // Maven
  /^\s*mvn\b/i,
  // Gradle (direct or wrapper)
  /^\s*(?:gradle|\.\/gradlew|gradlew)\b/i,
  // Python / pip
  /^\s*pip\s+(install|freeze)\b/i,
  // Poetry
  /^\s*poetry\s+(install|update)\b/i,
  // uv
  /^\s*uv\s+(sync|pip\s+install)\b/i,
  // Bundler (Ruby)
  /^\s*bundle\s+(install|update)\b/i,
  // Mix (Elixir)
  /^\s*mix\s+(deps\.get|compile|test)\b/i,
  // dotnet
  /^\s*dotnet\s+(build|test|restore)\b/i,
  // Make
  /^\s*make\b/i,
  // CMake build
  /^\s*cmake\s+--build\b/i,
  // Rake (Ruby)
  /^\s*rake\b/i,
  // TypeScript compiler (direct and via npx)
  /^\s*tsc(?:\s|$)/i,
  /^\s*npx\s+tsc(?:\s|$)/i,
  // Vite
  /^\s*vite\s+(build|dev|preview)\b/i,
  // Next.js
  /^\s*next\s+(build|dev|start)\b/i,
  // Nuxt
  /^\s*nuxt\s+(build|dev)\b/i,
  // Webpack
  /^\s*webpack\b/i,
  // esbuild
  /^\s*esbuild\b/i,
  // Rollup
  /^\s*rollup\b/i,
  // Turbo
  /^\s*turbo\s+(build|dev)\b/i,
]

// ---------------------------------------------------------------------------
// Count exports — keep these in sync with their source arrays above.
// Dynamic sizes are computed from the live Sets/Arrays so they update
// automatically when entries are added.
// ---------------------------------------------------------------------------

export const LOCK_FILE_COUNT = LOCK_FILE_NAMES.size
export const MANIFEST_FILE_COUNT = MANIFEST_FILE_NAMES.size + MANIFEST_EXTENSIONS.size + MANIFEST_BASENAME_PATTERNS.length
export const BUILD_DIR_COUNT = BUILD_DIR_NAMES.size
export const GENERATED_EXT_COUNT = ALWAYS_GENERATED_EXTS.size + CONDITIONALLY_GENERATED_EXTS.size

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * True when `basename` (case-insensitive) is a known lock file.
 *
 * @param basename - The filename only, no directory prefix.
 */
export function isLockFile(basename: string): boolean {
  return LOCK_FILE_NAMES.has(basename.toLowerCase())
}

/**
 * True when `basename` (case-insensitive) is a known manifest / config file.
 *
 * @param basename - The filename only, no directory prefix.
 */
export function isManifestFile(basename: string): boolean {
  const lower = basename.toLowerCase()
  if (MANIFEST_FILE_NAMES.has(lower)) return true
  const dot = lower.lastIndexOf('.')
  if (dot !== -1 && MANIFEST_EXTENSIONS.has(lower.slice(dot))) return true
  if (MANIFEST_BASENAME_PATTERNS.some((re) => re.test(basename))) return true
  return false
}

/**
 * Split a normalized path into its individual segments for directory matching.
 * Handles both forward and backward slashes.
 */
function pathSegments(filePath: string): string[] {
  return filePath.split(/[/\\]/).filter((s) => s.length > 0)
}

/**
 * True when `filePath` is inside a known build output directory.
 *
 * Checks every segment of the path (not just the first), so nested structures
 * like `packages/core/dist/index.js` are caught.
 *
 * node_modules is intentionally excluded — hooks_read.ts handles it separately
 * with its own deny message.
 */
export function isInBuildDir(filePath: string): boolean {
  const segments = pathSegments(filePath)
  // Check all segments except the last (filename).
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    if (seg !== undefined && BUILD_DIR_NAMES.has(seg.toLowerCase())) return true
  }
  return false
}

/**
 * True when `filePath` is a generated / compiled artifact that should not be
 * read directly.
 *
 * Covers:
 *  - Always-generated extensions (`.pyc`, `.class`, `.o`, `.dll`, etc.)
 *  - Conditionally-generated extensions (`.map`, `.d.ts`) only when the path
 *    is inside a build / dist directory.
 */
export function isGeneratedFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  // Check always-generated extensions.
  for (const ext of ALWAYS_GENERATED_EXTS) {
    if (lower.endsWith(ext)) return true
  }
  // Check conditionally-generated extensions (only in build dirs).
  for (const ext of CONDITIONALLY_GENERATED_EXTS) {
    if (lower.endsWith(ext) && isInBuildDir(filePath)) return true
  }
  return false
}

/**
 * True when `cmd` matches a known build tool command whose output is worth
 * caching for re-inspection via `token-goat bash-output`.
 *
 * @param cmd - The full bash command string.
 */
export function isBuildCommand(cmd: string): boolean {
  return BUILD_COMMAND_PATTERNS.some((re) => re.test(cmd))
}

/**
 * Monitoring command patterns — long-running or repeatedly-run commands whose
 * output is always worth recalling from cache rather than re-running.
 *
 * Each entry carries a `recallHint` string with --grep / --tail flags to pass
 * to `token-goat bash-output` for surgical inspection.
 */
export const MONITORING_COMMAND_PATTERNS: Array<{
  pattern: RegExp
  recallHint: string
}> = [
  // GitHub CI
  { pattern: /^gh run (?:watch|view|list)/, recallHint: '--grep "fail|error|pass|✓|✗|conclusion"' },
  { pattern: /^gh run view.*--log/, recallHint: '--tail 100 --grep "Error|FAIL|error"' },
  { pattern: /^gh pr checks/, recallHint: '--grep "fail|error|pass|pending"' },
  { pattern: /^gh workflow (?:run|list|view)/, recallHint: '--grep "completed|failed|in_progress"' },

  // Dev servers (Next, Vite, Nuxt, Remix, Astro)
  { pattern: /^(?:npx\s+)?next dev/, recallHint: '--tail 30 --grep "error|warn|ready|compiled"' },
  { pattern: /^(?:npx\s+)?next build/, recallHint: '--grep "error|warn|Failed|✓"' },
  { pattern: /^(?:npx\s+)?vite(?:\s+dev|\s+build|\s+preview)?$/, recallHint: '--tail 20 --grep "error|warn|ready"' },
  { pattern: /^(?:npx\s+)?nuxt dev/, recallHint: '--tail 30 --grep "error|warn|ready"' },
  { pattern: /^(?:npx\s+)?remix dev/, recallHint: '--tail 20 --grep "error|warn|ready"' },
  { pattern: /^(?:npx\s+)?astro dev/, recallHint: '--tail 20 --grep "error|warn|ready"' },

  // Test watchers
  { pattern: /^(?:npx\s+)?vitest(?:\s+run|\s+watch)?/, recallHint: '--grep "FAIL|PASS|Error|✓|✗"' },
  { pattern: /^(?:npx\s+)?jest(?:\s+--watch)?/, recallHint: '--grep "FAIL|PASS|Error|Tests:"' },
  { pattern: /^pytest(?:\s|$)/, recallHint: '--grep "FAILED|PASSED|ERROR|passed|failed"' },
  { pattern: /^(?:cargo\s+test|cargo\s+watch)/, recallHint: '--grep "FAILED|ok|error\\["' },
  { pattern: /^go test/, recallHint: '--grep "FAIL|ok|---"' },

  // Docker / compose
  { pattern: /^docker(?:\s+compose)?\s+logs/, recallHint: '--tail 50 --grep "error|warn|Error|WARN"' },
  { pattern: /^docker-compose\s+logs/, recallHint: '--tail 50 --grep "error|warn|Error|WARN"' },

  // File watchers / hot-reload
  { pattern: /^nodemon/, recallHint: '--tail 20 --grep "error|crash|restart"' },
  { pattern: /^air(?:\s|$)/, recallHint: '--tail 20 --grep "error|build failed"' },
  { pattern: /^cargo watch/, recallHint: '--tail 20 --grep "error\\[|warning\\["' },
  { pattern: /^watchexec/, recallHint: '--tail 20 --grep "error|warn"' },

  // Linters / formatters run repeatedly
  { pattern: /^(?:npx\s+)?eslint(?:\s|$)/, recallHint: '--grep "error|warning|✖|problems"' },
  { pattern: /^(?:npx\s+)?prettier(?:\s|$)/, recallHint: '--grep "unchanged|reformatted|error"' },
  { pattern: /^npx\s+tsc(?:\s|$)/, recallHint: '--grep "error TS|Cannot find|Type "' },
  { pattern: /^ruff(?:\s|$)/, recallHint: '--grep "error|warning|Found"' },
  { pattern: /^(?:cargo\s+)?clippy/, recallHint: '--grep "error\\[|warning\\["' },

  // git diff (full diff output — can be very large; excludes --stat which is small)
  { pattern: /^git diff(?!\s+--stat)(?:\s+HEAD)?(?:\s|$)/, recallHint: '--grep "@@|\\+\\+\\+|---|diff --git"' },
  { pattern: /^git diff\s+--cached(?!\s+--stat)/, recallHint: '--grep "@@|\\+\\+\\+|---|diff --git"' },

  // npm run * wrappers (npm test is excluded — too generic; npm run test is explicit)
  { pattern: /^npm run (?:test|spec)(?:\s|$)/, recallHint: '--grep "FAIL|PASS|Error|Tests:|✓|✗"' },
  { pattern: /^npm run build(?:\s|$)/, recallHint: '--grep "error|Built|Failed|✓|✗"' },
  { pattern: /^npm run (?:lint|typecheck|check|type-check)(?:\s|$)/, recallHint: '--grep "error|warning|✖|problems"' },

  // node scripts (migration runners, seed generators, etc. run repeatedly)
  { pattern: /^node\s+(?:scripts|src\/scripts)\/\S+\.m?js\b/, recallHint: '--tail 50 --grep "error|Error|done|complete|inserted|migrated"' },

  // External AI peer-review CLI tools (produce large outputs, run repeatedly per session)
  { pattern: /^codex(?:\s|$)/, recallHint: '--tail 100 --grep "error|suggestion|verdict|conclusion"' },
  { pattern: /^(?:~\/\.claude\/bin\/|\.claude\/bin\/)?glm\.sh(?:\s|$)/, recallHint: '--tail 100 --grep "error|verdict|conclusion|suggestion"' },

  // cat of a single source file — output is the full file; pre-bash emits a token-goat read suggestion
  { pattern: /^cat\s+\S+\.(java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj)\s*$/, recallHint: '--tail 50' },

  // PowerShell read-only system-state queries (stable over 60-120s)
  {
    pattern: /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-\w+\s+)*-Command\s+["']?Get-(?:CimInstance|Process|Counter|Service|PSDrive|WmiObject)\b/i,
    recallHint: '--tail 50',
  },
  // token-goat section/outline/symbol repeat calls — output is stable until the file changes
  { pattern: /^token-goat\s+section\s+["'][^"']+["']/, recallHint: '' },
  { pattern: /^token-goat\s+outline\s+\S+/, recallHint: '' },
  { pattern: /^token-goat\s+symbol\s+\S+/, recallHint: '' },
]

/**
 * Returns true when a PowerShell -Command block is a multiline read-only system diagnostic
 * (contains Get-CimInstance/Get-Process/etc. with no destructive cmdlets like Remove-/Set-/Stop-Process).
 *
 * The existing single-line pattern handles `-Command "Get-*"` where Get-* is the first token.
 * This covers the multiline form:
 *   powershell -Command "
 *   # Disk usage
 *   Get-PSDrive C | ...
 *   $os = Get-CimInstance Win32_OperatingSystem
 *   ..."
 */
function isPsMultilineSystemQuery(cmd: string): boolean {
  if (!/^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+/i.test(cmd)) return false
  const cmdIdx = cmd.search(/-Command\b/i)
  if (cmdIdx === -1) return false
  const afterCmd = cmd.slice(cmdIdx + '-Command'.length).trimStart()
  if (!/^["']/.test(afterCmd)) return false
  const body = afterCmd.slice(1) // strip leading quote
  if (!body.includes('\n')) return false // single-line form is already covered by MONITORING_COMMAND_PATTERNS
  if (!/\bGet-(?:CimInstance|Process|Counter|Service|PSDrive|WmiObject)\b/i.test(body)) return false
  // Exclude blocks containing destructive or state-changing PS cmdlets
  if (/\b(?:Remove|Set|New|Restart|Install|Uninstall|Enable|Disable|Grant|Revoke|Invoke-(?:Expression|Command)|Register|Unregister|Clear-(?:Content|EventLog|Item))-/i.test(body)) return false
  if (/\bStop-(?:Process|Service|Computer)\b/i.test(body)) return false
  return true
}

/**
 * Returns the recall hint string for `cmd` if it matches a known monitoring
 * command pattern, otherwise returns `null`.
 */
export function getMonitoringRecallHint(cmd: string): string | null {
  const trimmed = cmd.trim()
  for (const { pattern, recallHint } of MONITORING_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) return recallHint
  }
  if (isPsMultilineSystemQuery(trimmed)) return '--tail 50'
  return null
}

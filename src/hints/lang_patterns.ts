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
])

/**
 * Glob suffixes that identify manifest files by extension (lowercased).
 * Used in addition to MANIFEST_FILE_NAMES for *.cabal files.
 */
const MANIFEST_EXTENSIONS: ReadonlySet<string> = new Set([
  '.cabal',
])

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
]

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

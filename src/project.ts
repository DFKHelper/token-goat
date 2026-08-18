/**
 * Project marker detection and path canonicalization.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shortFingerprint } from './fingerprint.js';
import { extractErrorMessage, foldPath, runGit } from './util.js';
import { lowercaseDriveLetter, expandShortPath, normalizeDarwinSystemAlias, WSL_PATH_RE, MSYS_PATH_RE } from './paths.js';

/**
 * Windows drive prefixes that resolve to the same NTFS location.
 * Cross-shell normalization (Git Bash, WSL, Cygwin, cmd.exe/PowerShell).
 */
const CYGWIN_PREFIX_RE = /^\/cygdrive\/([a-zA-Z])\/(.*)$/s;

export const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'shopify.app.toml',
  '_config.yml',
  'deno.json',
  'deno.jsonc',
] as const;

const REPO_CONTAINER_THRESHOLD = 3;

/**
 * Project root with hash and marker file.
 */
export interface Project {
  root: string;
  hash: string;
  marker: string;
}

/**
 * Map WSL / Cygwin / MSYS Windows-drive prefixes to canonical `c:/` form.
 * Called after path.resolve + forward-slash conversion.
 */
function normalizeShellDrivePrefix(posixStr: string): string {
  let m = WSL_PATH_RE.exec(posixStr);
  if (m) {
    return `${m[1]!.toLowerCase()}:/${m[2]}`;
  }
  m = CYGWIN_PREFIX_RE.exec(posixStr);
  if (m) {
    return `${m[1]!.toLowerCase()}:/${m[2]}`;
  }
  m = MSYS_PATH_RE.exec(posixStr);
  if (m) {
    // MSYS_PATH_RE's trailing group already includes its own leading slash (or is absent for a
    // bare drive root), unlike WSL/Cygwin's `rest` group above -- so this branch alone omits the
    // hardcoded `:/` separator, matching paths.ts::normalizePath's step-2b formatting exactly.
    return `${m[1]!.toLowerCase()}:${m[2] ?? '/'}`;
  }
  return posixStr;
}

/**
 * Normalize a path lexically and lowercase the Windows drive letter.
 *
 * Deliberately does NOT resolve symlinks: it must produce a stable key for paths that do not
 * exist (deleted or not-yet-written files still need one). Callers that need link resolution --
 * {@link isInsideRoot}, which enforces a security boundary -- must call realpath themselves.
 */
export function canonicalize(inputPath: string | URL, baseDir?: string): string {
  const pathStr = typeof inputPath === 'string' ? inputPath : inputPath.pathname;
  // Windows-only: rewrites MSYS/WSL/Cygwin style paths (e.g. /mnt/c/foo) to drive-letter form
  // before path.resolve() runs. On real POSIX Node, path.resolve() is POSIX resolve and doesn't
  // understand drive-letter syntax, so rewriting first would corrupt an otherwise-valid POSIX
  // path. Mirrors the win32 gate in paths.ts's normalizePath().
  const isWin32 = process.platform === 'win32';
  // baseDir lets a caller resolve a relative/WSL-mount path against a directory other than
  // this process's cwd (e.g. isProjectFrame in text_commands.ts, resolving a traceback frame
  // against the cwd captured by the trace command rather than assuming it matches process.cwd()).
  const base = baseDir ?? process.cwd();

  // Pre-resolve normalization: convert MSYS/WSL/Cygwin prefix before resolve.
  const slashed = pathStr.replace(/\\/g, '/');
  let pre = isWin32 ? normalizeShellDrivePrefix(slashed) : slashed;
  if (pre !== slashed) {
    pre = (isWin32 ? path.win32.resolve : path.resolve)(base, pre);
  } else {
    pre = (isWin32 ? path.win32.resolve : path.resolve)(base, pathStr);
  }

  // Convert to forward slashes and normalize shell prefixes.
  let normalized = pre.replace(/\\/g, '/');
  if (isWin32) {
    normalized = normalizeShellDrivePrefix(normalized);
  }

  // Expand a Windows 8.3 short-name segment (e.g. `JOHNDO~1.ACM`) to its long form: %TEMP%/%USERPROFILE% can be pinned to short form, which every os.tmpdir()-based path inherits, while git always emits long form, so without this the same physical path canonicalizes two different ways depending on its source. Shared with normalizePath (paths.ts) via expandShortPath so the rule can't drift between the two call sites.
  normalized = expandShortPath(normalized);

  // macOS exposes /var as /private/var after chdir. Normalize that system alias
  // so existing, deleted, and future paths all have one canonical form.
  normalized = normalizeDarwinSystemAlias(normalized);

  // Lowercase drive letter on Windows (e.g., "C:/foo" → "c:/foo"). Shared with
  // normalizePath (paths.ts) via lowercaseDriveLetter so the rule can't drift.
  normalized = lowercaseDriveLetter(normalized);

  return normalized;
}

/**
 * Return SHA256 hash (first 16 chars, hex) of canonical posix path.
 */
export function projectHash(canonicalRoot: string): string {
  // canonicalize() only lowercases the drive letter, not the rest of the path, so two
  // differently-cased strings for the identical physical directory on a case-insensitive
  // filesystem (Windows/macOS) would otherwise hash to different keys and split one
  // project's state directory (compact.ts's writeSessionManifest keys sessions by this
  // hash) across two hashes. Fold through foldPath (util.ts) first, matching the
  // platform-gated convention used elsewhere (isUnderBlockedRoot, assertWalkableRoot,
  // pruneDeletedFiles).
  return shortFingerprint(foldPath(canonicalRoot));
}

/**
 * Create a Project for any directory without requiring a project marker.
 */
export function makeProjectAt(root: string | URL): Project {
  let canonical: string;
  try {
    canonical = canonicalize(root);
  } catch (exc) {
    throw new Error(
      `makeProjectAt: could not resolve path: ${extractErrorMessage(exc)}`,
      { cause: exc }
    );
  }

  try {
    const stat = fs.statSync(canonical);
    if (!stat.isDirectory()) {
      throw new Error(`makeProjectAt: path is not a directory: ${canonical}`);
    }
  } catch (exc) {
    if (exc instanceof Error && exc.message.includes('ENOENT')) {
      throw new Error(`makeProjectAt: path does not exist: ${canonical}`, { cause: exc });
    }
    throw exc;
  }

  const hash = projectHash(canonical);
  return { root: canonical, hash, marker: 'manual' };
}

/**
 * True if path merely contains independent repos rather than being a project.
 */
function isRepoContainer(pathStr: string): boolean {
  let nestedRepos = 0;
  try {
    const entries = fs.readdirSync(pathStr, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Build the path from pathStr (already known) + entry.name rather than entry.path/
        // entry.parentPath: entry.path only exists from Node 20.1+ and is undefined on Node
        // 18/19 (this package's declared minimum), which throws inside this try and silently
        // disables repo-container detection via the catch below.
        const gitPath = path.join(pathStr, entry.name, '.git');
        if (fs.existsSync(gitPath)) {
          // A git-submodule (or worktree) root has a `.git` FILE -- a one-line `gitdir: ...`
          // pointer into the superproject's `.git/modules` -- not a real independent repo.
          // Only a `.git` DIRECTORY is a genuinely separate repo root and should count toward
          // the container threshold; otherwise a monorepo with 3+ submodules at its root gets
          // misclassified as a container of unrelated repos, and findProject walks past the
          // actual project root.
          let isGitDir = false;
          try {
            isGitDir = fs.statSync(gitPath).isDirectory();
          } catch {
            // Race between existsSync and statSync (deleted, permissions): treat as not a
            // nested repo rather than aborting the whole directory scan.
          }
          if (isGitDir) {
            nestedRepos++;
            if (nestedRepos >= REPO_CONTAINER_THRESHOLD) {
              return true;
            }
          }
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Return true when marker exists and is not a symlink escaping the root.
 */
function markerExists(current: string, marker: string): boolean {
  const markerPath = path.join(current, marker);
  try {
    if (!fs.existsSync(markerPath)) {
      return false;
    }
    const stat = fs.lstatSync(markerPath);
    if (!stat.isSymbolicLink()) {
      return true;
    }
    // Symlink: verify target stays inside current. On Windows, path.relative() across drive
    // letters (e.g. C:\project -> D:\evil\file) returns the absolute target path unchanged
    // rather than a '..'-prefixed relative path, so the startsWith('..') check alone lets a
    // cross-drive escaping symlink through; also reject any result that is itself absolute
    // (mirrors hooks_read.ts's relPathWithinRoot / pack.ts's isPathWithinRoot).
    const resolved = fs.realpathSync(markerPath);
    const rel = path.relative(path.resolve(current), path.resolve(resolved));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Walk up from cwd looking for a project marker.
 */
export function findProject(cwd: string): Project | null {
  let p: string;
  try {
    p = canonicalize(cwd);
  } catch {
    return null;
  }

  let sysTemp: string | null = null;
  try {
    sysTemp = canonicalize(os.tmpdir());
  } catch {
    // ignore
  }

  let current = p;

  while (true) {
    // canonicalize() only lowercases the drive letter, not the rest of the path. `current`
    // (from cwd) and `sysTemp` (from os.tmpdir(), which reads TEMP/TMP/TMPDIR) can
    // legitimately differ in case beyond the drive letter, so fold both sides before
    // comparing -- matching the platform-gated convention used elsewhere (isUnderBlockedRoot,
    // assertWalkableRoot, pruneDeletedFiles) -- or this guard silently stops matching and the
    // walk continues past the temp boundary.
    if (
      sysTemp &&
      normalizeDarwinSystemAlias(foldPath(current)) ===
        normalizeDarwinSystemAlias(foldPath(sysTemp))
    ) {
      break;
    }

    for (const marker of PROJECT_MARKERS) {
      if (markerExists(current, marker)) {
        if (!isRepoContainer(current)) {
          return {
            root: current,
            hash: projectHash(current),
            marker,
          };
        }
        break;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

let _displayRootCache: { cwd: string; root: string | undefined } | null = null;

/**
 * Resolve the project root to use for shortening an indexed absolute path to a project-relative
 * one for human-facing CLI output (see `toDisplayPath()` in `paths.ts`).
 *
 * Precedence: an explicitly-passed root wins outright (a caller that already resolved its own
 * project root for querying, e.g. via `resolveProjectRoot()`); otherwise fall back to the cheap,
 * subprocess-free `findProject()` marker walk from `process.cwd()`; otherwise `undefined`, which
 * `toDisplayPath()` treats as "no project found" and returns the path unchanged (absolute).
 *
 * Deliberately never falls back to `process.cwd()` itself as a display root -- only to the
 * *project root* that `findProject()` resolves by walking up from cwd. Using cwd directly would
 * make output depend on which subdirectory the command was run from; the marker-walked project
 * root is stable regardless of cwd's subdirectory.
 *
 * Memoized per `process.cwd()` for the explicit-root-omitted branch, matching
 * `resolveConfigProjectRoot()`'s (config.ts) memoization rationale: this is a one-shot CLI
 * process, cwd does not change within its lifetime, but a single command can call this helper in
 * a loop over many result rows, so the marker walk should run once per process, not once per row.
 */
export function getDisplayRoot(explicitRoot?: string): string | undefined {
  if (explicitRoot !== undefined) return explicitRoot;
  const cwd = process.cwd();
  if (_displayRootCache !== null && _displayRootCache.cwd === cwd) return _displayRootCache.root;
  const project = findProject(cwd);
  const root = project !== null ? project.root : undefined;
  _displayRootCache = { cwd, root };
  return root;
}

/**
 * True when `filePath` lives inside the OS system temp directory (`os.tmpdir()`), including any
 * subdirectory of it -- scratch checkouts, ad hoc debugging copies, per-test fixture dirs, etc.
 *
 * Nothing under system temp should ever become a permanent index citizen: it is ephemeral by
 * definition, often a byte-identical duplicate of a real project checked out elsewhere for
 * throwaway work. Without this guard, editing a file inside such a copy (e.g. via an AI coding
 * agent's own scratchpad) silently and permanently indexes it as a distinct "project" -- observed
 * in practice on this repo's own global index, where half a dozen old scratch-dir copies of
 * token-goat's own source produced 8+ duplicate results for every single `symbol`/`dead`/`refs`
 * lookup, with no existing cleanup path. Used to gate future auto-indexing (hooks_edit.ts) and to
 * retroactively purge already-polluted rows (`project prune`, cli_project_commands.ts).
 */
export function isUnderSystemTemp(filePath: string): boolean {
  let sysTemp: string;
  try {
    sysTemp = canonicalize(os.tmpdir());
  } catch {
    return false;
  }
  let target: string;
  try {
    target = canonicalize(filePath);
  } catch {
    return false;
  }
  const foldedTemp = normalizeDarwinSystemAlias(foldPath(sysTemp));
  const foldedTarget = normalizeDarwinSystemAlias(foldPath(target));
  // canonicalize() always normalizes to forward slashes (both win32 and posix) -- comparing
  // against path.sep (backslash on Windows) here would silently never match a real prefix.
  return foldedTarget === foldedTemp || foldedTarget.startsWith(`${foldedTemp}/`);
}

/**
 * Resolve "the current project root" using one shared precedence, replacing three
 * previously-divergent conventions that had drifted apart across the codebase:
 *   - read_commands.ts's `runChanged` used `opts.projectRoot ?? process.cwd()`, then
 *     unconditionally tried to override that with `git rev-parse --show-toplevel`.
 *   - resume.ts used `findProject(process.cwd())?.root ?? process.cwd()`, with no git
 *     step at all.
 *   - cli_context_stats.ts used a bare `path.resolve(opts.project ?? process.cwd())`,
 *     with neither a git nor a findProject step.
 *
 * Resolution starts from a base directory -- `opts.project` if given (resolved to an
 * absolute path), else `process.cwd()` -- and then, from that base:
 *   1. `git rev-parse --show-toplevel`, if the base directory is inside a git repo. This
 *      matters because callers that pass changed-file paths through (e.g. `git diff
 *      --name-only`) always get them relative to the repo top-level, regardless of which
 *      subdirectory git was invoked from; resolving to the top-level keeps those relative
 *      paths correct even when the base directory is a subdirectory of the repo.
 *   2. Else, {@link findProject}'s marker-based project root (package.json, .git, etc.),
 *      walking up from the base directory -- this covers non-git projects.
 *   3. Else, the base directory itself.
 */
export function resolveProjectRoot(opts?: { project?: string }): string {
  const base = opts?.project !== undefined ? path.resolve(opts.project) : process.cwd();
  const toplevel = runGit(['rev-parse', '--show-toplevel'], { cwd: base });
  if (toplevel.exitCode === 0) {
    const trimmed = toplevel.stdout.trim();
    // `git rev-parse` echoes back whatever drive-letter casing the OS reports (often uppercase
    // on Windows), unlike every other project-root source in this module (findProject,
    // makeProjectAt), which is always canonicalize()'d. Canonicalizing here too keeps the
    // return value consistent regardless of which resolution step produced it.
    if (trimmed.length > 0) return canonicalize(trimmed);
  }
  const project = findProject(base);
  if (project !== null) return project.root;
  return canonicalize(base);
}

/**
 * Is `target` the same path as `root`, or somewhere beneath it?
 *
 * Both sides are resolved through the real filesystem before comparison, then canonicalized, so
 * shell-mount spellings (`/mnt/c/...`, `/c/...`), separator direction, drive-letter case and 8.3
 * short names all compare equal. Resolving links is the load-bearing step: `canonicalize` does
 * NOT call realpath, so a directory symlink inside the root pointing out of it (`<root>/link` ->
 * `/other-project`) satisfies a purely lexical prefix test while naming a file the caller was
 * confined away from. `realpathSync` is best-effort -- a path that does not exist yet has no link
 * to resolve and falls back to its lexical form, which is the safe direction here since a
 * nonexistent path cannot be read either way.
 *
 * The trailing-separator guard is what stops `/srv/project-secrets` from reading as inside
 * `/srv/project`. Case is folded via foldPath, which asks the platform rather than assuming
 * Windows: a default macOS APFS volume is case-insensitive too, and folding only on Windows
 * rejected `--file /Users/alice/repo/x.ts` under a root git reports as `/Users/alice/Repo`.
 */
export function isInsideRoot(target: string, root: string): boolean {
  const resolve = (p: string): string => {
    const c = canonicalize(p);
    try {
      return canonicalize(fs.realpathSync(c));
    } catch {
      return c;
    }
  };
  const t = foldPath(resolve(target));
  const r = foldPath(resolve(root));
  if (t === r) return true;
  return t.startsWith(r.endsWith('/') ? r : r + '/');
}

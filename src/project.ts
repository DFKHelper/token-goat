/**
 * Project marker detection and path canonicalization.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractErrorMessage, foldPath } from './util.js';
import { lowercaseDriveLetter } from './paths.js';

/**
 * Windows drive prefixes that resolve to the same NTFS location.
 * Cross-shell normalization (Git Bash, WSL, Cygwin, cmd.exe/PowerShell).
 */
const WSL_PREFIX_RE = /^\/mnt\/([a-zA-Z])\/(.*)$/;
const CYGWIN_PREFIX_RE = /^\/cygdrive\/([a-zA-Z])\/(.*)$/;
const MSYS_PREFIX_RE = /^\/([a-zA-Z])\/(.*)$/;

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
  let m = WSL_PREFIX_RE.exec(posixStr);
  if (m) {
    return `${m[1]!.toLowerCase()}:/${m[2]}`;
  }
  m = CYGWIN_PREFIX_RE.exec(posixStr);
  if (m) {
    return `${m[1]!.toLowerCase()}:/${m[2]}`;
  }
  m = MSYS_PREFIX_RE.exec(posixStr);
  if (m) {
    return `${m[1]!.toLowerCase()}:/${m[2]}`;
  }
  return posixStr;
}

/**
 * Resolve symlinks, normalize, lowercase the Windows drive letter.
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
  const hash = crypto
    .createHash('sha256')
    .update(foldPath(canonicalRoot), 'utf-8')
    .digest('hex');
  return hash.slice(0, 16);
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
          nestedRepos++;
          if (nestedRepos >= REPO_CONTAINER_THRESHOLD) {
            return true;
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
    // Symlink: verify target stays inside current.
    const resolved = fs.realpathSync(markerPath);
    const rel = path.relative(path.resolve(current), path.resolve(resolved));
    return !rel.startsWith('..');
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
    if (sysTemp && foldPath(current) === foldPath(sysTemp)) {
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

/**
 * Path canonicalization and the symlink-resolving containment test.
 *
 * A LEAF module by design: it imports node built-ins and `paths.ts` and nothing else. That is a
 * structural constraint, not tidiness. `isInsideRoot` is the check the installer write helpers in
 * `util.ts` run on every write (via bridges/project_scope_guard.ts), and `util.ts` is itself
 * imported by `project.ts` -- so leaving this code in `project.ts` closed a
 * util -> project_scope_guard -> project -> util cycle. Under vitest's
 * `vi.mock('../src/util.js', importOriginal)` that cycle made `project.ts` bind the REAL
 * `runGit` instead of the mocked one, and six read_commands tests started spawning git for real.
 * A production ESM bundle tolerates the cycle; the point is that a module on the critical path of
 * every write should not depend on load order to be correct.
 *
 * `project.ts` and `util.ts` both re-export from here, so every existing
 * `import { isInsideRoot } from './project.js'` and `import { foldPath } from './util.js'`
 * keeps resolving to the same live binding.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { lowercaseDriveLetter, expandShortPath, normalizeDarwinSystemAlias, WSL_PATH_RE, MSYS_PATH_RE } from './paths.js';

/** Whether this platform's filesystem compares names case-insensitively. `TOKEN_GOAT_CASE_INSENSITIVE_FS` overrides, for tests on a platform whose default disagrees. */
export function isCaseInsensitiveFs(): boolean {
  const o = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'];
  if (o === '1') return true;
  if (o === '0') return false;
  return process.platform === 'win32' || process.platform === 'darwin';
}

/** Case-fold a path, but only where the filesystem itself folds. */
export function foldPath(p: string): string {
  return isCaseInsensitiveFs() ? foldCase(p) : p;
}

/** Unicode-aware case fold. Separate from {@link foldPath} because `db.ts` mirrors THIS one into SQL as a custom `LOWER()`, ungated by platform. */
export function foldCase(s: string): string {
  return s.toLowerCase();
}

/**
 * Windows drive prefixes that resolve to the same NTFS location.
 * Cross-shell normalization (Git Bash, WSL, Cygwin, cmd.exe/PowerShell).
 */
const CYGWIN_PREFIX_RE = /^\/cygdrive\/([a-zA-Z])\/(.*)$/s;

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

/**
 * Canonical form of `p` with every symlink on it followed, INCLUDING when `p` does not exist yet.
 *
 * `realpathSync` throws ENOENT the moment any component is missing, which for an installer is the
 * ordinary case: it is asked about a file it is about to create. The previous version caught that
 * throw and returned the merely-lexical path, so {@link isInsideRoot} silently degraded to a
 * lexical prefix test in exactly the situation it exists to guard. That was a real hole, not a
 * theoretical one: a repository that commits `.github` as a DIRECTORY symlink with no leaf file
 * behind it made `install --vscode --project` exit 0 and write four files outside the project.
 * (With the leaf present, realpath succeeded and the install was correctly refused -- the coverage
 * asymmetry was the bug.)
 *
 * So: walk the path one segment at a time from the filesystem root, following any segment that
 * `readlink` answers for and appending any that it does not. A per-segment walk rather than
 * "realpath the existing ancestor, re-append the rest" because the shortcut version was wrong in
 * two ways that a green suite did not see:
 *
 *  - It walked UP with `path.posix.dirname`, and `path.posix.dirname('x:/dangfile')` is `'x:'` --
 *    slashless, so the loop exited before the DRIVE ROOT was ever tried and a dangling link sitting
 *    directly in `x:/` took the lexical fallback, reporting a target outside the root as inside it.
 *    POSIX was unaffected (`dirname('/dangfile')` is `'/'`), which is why it survived CI.
 *  - It handed the whole path to `canonicalize` first, which collapses `..` with `path.resolve`
 *    BEFORE any link is followed, so `<root>/link/../sneak.txt` with `link` a junction out of the
 *    root erased the link lexically and read as inside. Here `..` is applied to a base that is
 *    already fully link-resolved, which is the only order that means anything.
 *
 * Only the leading `..`-free part of the input goes through {@link canonicalize} (for the drive
 * form, shell-mount spellings and 8.3 short names); everything after the first `..` is walked
 * verbatim. Returns {@link UNRESOLVABLE_PATH} when the link chain does not terminate, which fails
 * every containment test in both directions rather than handing a cycle a lexical answer.
 */
const UNRESOLVABLE_PATH = 'unresolvable-link-chain'; // slashless, so no canonicalized path can equal it

/** Symlink hops followed before a chain is called a cycle. Mirrors a typical kernel ELOOP limit. */
const MAX_LINK_HOPS = 40;

/**
 * Longest path this walk will look at, in bytes. Matches Linux's PATH_MAX.
 *
 * A refusal, not a heuristic: no supported platform can name a real file with a path this long
 * (Linux PATH_MAX is 4096, macOS 1024, Windows 260 without long-path support and 32767 with it,
 * but nothing token-goat installs or reads lives near any of those), so a longer path cannot be a
 * legitimate question and answering "not contained" is correct rather than conservative.
 *
 * It is here rather than at the three hook call sites deliberately. This walk is reached BEFORE
 * VS Code asks the user to approve a tool call -- `getFilePath(event)` hands back
 * `toolInput.file_path` verbatim, `vscodePathAllowed` clears a purely LEXICAL prefix test that
 * `<workspace>` plus twenty thousand `/a` segments satisfies trivially, and then this runs, with
 * no timeout anywhere on the in-process hook path. Capping at the call sites would have left
 * `assertProjectScopeTarget` and every CLI caller uncapped.
 */
const MAX_RESOLVE_PATH_BYTES = 4096;

/**
 * Segments walked before the resolution is abandoned.
 *
 * The byte cap above bounds the INPUT, but each followed link splices its own target's segments
 * into the remaining work, so the walk can outgrow its input. MAX_LINK_HOPS bounds how many times
 * that can happen and this bounds the total, so the two together make the walk linear in a fixed
 * quantity rather than in anything an attacker chooses.
 */
const MAX_WALK_SEGMENTS = MAX_RESOLVE_PATH_BYTES * (MAX_LINK_HOPS + 1);

/** Absolute root of `p` (`/`, `c:/`, `//server/share`) and its segments, with `..` PRESERVED. */
function rootAndSegments(p: string): { root: string; segs: string[] } {
  const parts = p.replace(/\\/g, '/').split('/');
  const up = parts.indexOf('..');
  const head = up === -1 ? parts.join('/') : parts.slice(0, up).join('/');
  const canon = canonicalize(head === '' ? '.' : head);
  const m = /^(\/\/[^/]+\/[^/]+|[a-z]:\/|\/)/i.exec(canon);
  const root = m === null ? '/' : (m[1] as string);
  const rest = canon.slice(root.length).split('/');
  return { root, segs: up === -1 ? rest : [...rest, ...parts.slice(up)] };
}

/** `base` with `seg` appended, tolerating a root that already ends in a slash. */
function joinSegment(base: string, seg: string): string {
  return base.endsWith('/') ? base + seg : `${base}/${seg}`;
}

/** `base`'s parent, clamped at `root` so `..` can never climb above the filesystem root. */
function parentSegment(base: string, root: string): string {
  const cut = base.lastIndexOf('/');
  return cut < root.length ? root : base.slice(0, cut);
}

/**
 * A `readlink` answer as a root (absolute targets) plus segments to walk.
 *
 * Windows junctions read back namespaced (`\\?\C:\target`, `\\?\UNC\server\share`), which no other
 * layer here strips, and an unstripped `//?/` prefix would be walked as if `?` were a directory.
 */
function linkTarget(link: string): { root: string | null; segs: string[] } {
  const raw = link.replace(/\\/g, '/').replace(/^\/\/[?.]\/(UNC\/)?/i, (_m, unc: string | undefined) => (unc === undefined ? '' : '//'));
  if (!/^(\/\/[^/]+\/|[a-z]:\/|\/)/i.test(raw)) return { root: null, segs: raw.split('/') };
  const abs = rootAndSegments(raw);
  return { root: abs.root, segs: abs.segs };
}

function resolveThroughLinks(p: string): string {
  if (Buffer.byteLength(p, 'utf8') > MAX_RESOLVE_PATH_BYTES) return UNRESOLVABLE_PATH;
  const start = rootAndSegments(p);
  let root = start.root;
  let base = root;
  // A LIFO stack of the segments still to walk, held in reverse so `pop()` is the next one. An
  // Array used as a FIFO was the shape here, and `shift()` is O(n) per call on a 200k-element
  // array: 20000 segments took 8.06s against the 4.3ms the single realpathSync it replaced spent
  // on the same input, and 200000 did not finish in 120s. Splicing a followed link's target in at
  // the front is the reason a plain index cursor is not enough on its own; pushing the target's
  // segments reversed onto the stack is the same operation at O(k).
  const stack = start.segs.slice().reverse();
  let hops = 0;
  let walked = 0;
  while (stack.length > 0) {
    if (++walked > MAX_WALK_SEGMENTS) return UNRESOLVABLE_PATH;
    const seg = stack.pop() as string;
    if (seg === '' || seg === '.') continue;
    // Safe lexically only because `base` is already resolved: every segment behind it was either
    // not a link or has been followed, so there is no link left for `..` to skip over.
    if (seg === '..') {
      base = parentSegment(base, root);
      continue;
    }
    const candidate = joinSegment(base, seg);
    // The RESOLVED path is capped as well as the input one. Bounding the input alone is not
    // enough: a followed link splices its own target in, so `base` can outgrow what the caller
    // supplied, and `joinSegment` reallocates the whole accumulated string on every segment --
    // the term that made the pre-cap cost grow worse than quadratically (38.4us per segment at
    // n=1000, 403us at 20000, 6510us at 200000, which `shift()`'s quadratic term alone does not
    // explain). Same closed direction: no real file is named by a resolved path this long.
    //
    // `Buffer.byteLength`, NOT `candidate.length`, and the two are not interchangeable: the
    // constant is named and documented in BYTES and the entry check above measures bytes, but
    // `String.length` counts UTF-16 code units. A resolved path of non-ASCII components therefore
    // passed a check nominally set at 4096 bytes while really being up to ~3x that (three UTF-8
    // bytes per BMP code unit), so the same constant meant two different bounds depending on which
    // of its two uses you read. Not a bypass -- MAX_WALK_SEGMENTS still terminates the loop -- but
    // the contract was wrong for one of the two, and the cheaper-looking unit was the wrong one.
    if (Buffer.byteLength(candidate, 'utf8') > MAX_RESOLVE_PATH_BYTES) return UNRESOLVABLE_PATH;
    let link: string | null = null;
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) link = fs.readlinkSync(candidate);
    } catch (err) {
      // ABSENT and UNREADABLE are not the same answer, and treating them as one was a hole. A
      // path that does not exist yet is the installer's ordinary case (ENOENT, or ENOTDIR when an
      // ancestor is a regular file -- in both the segment provably is not a link, so appending it
      // verbatim is the truth). Every other errno means this process could not SEE whether the
      // segment is a link: EACCES on an untraversable ancestor, EPERM, EIO, ELOOP. Appending
      // those verbatim produced an under-resolved path that then satisfied a containment test it
      // had never actually been checked against, so they fail closed instead.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return UNRESOLVABLE_PATH;
      link = null;
    }
    if (link === null) {
      base = candidate;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return UNRESOLVABLE_PATH;
    const target = linkTarget(link);
    if (target.root !== null) {
      root = target.root;
      base = target.root;
    }
    for (let i = target.segs.length - 1; i >= 0; i--) stack.push(target.segs[i] as string);
  }
  return base;
}

/**
 * Unicode-normalize a path only where the filesystem itself does.
 *
 * `foldPath` folds case but leaves composition alone, so a repository that commits an NFD-spelled
 * path (`e` + U+0301) against an NFC-spelled root (U+00E9) compared unequal. On macOS that is
 * wrong in both directions of the same coin: HFS+ stores NFD and APFS is normalization-
 * INSENSITIVE, so the two spellings are one file there and the mismatch made `isInsideRoot`
 * answer "outside" about a path that is provably inside -- a refusal, so the shipped direction
 * was closed rather than open, but a legitimate macOS checkout was being declined.
 *
 * Gated on darwin, and that gate is load-bearing rather than caution: ext4 and NTFS are
 * normalization-SENSITIVE, so `café` NFC and `café` NFD really are two different directories
 * there and normalizing would make an outside path read as inside -- the open direction. Applied
 * at the containment boundary only, not inside `foldPath`, which `db.ts` mirrors into SQL through
 * `foldCase` and which would then have to be mirrored there too or silently diverge.
 */
function normalizeForFs(p: string): string {
  return process.platform === 'darwin' ? p.normalize('NFC') : p;
}

/**
 * Is `target` the same path as `root`, or somewhere beneath it?
 *
 * Both sides are resolved through the real filesystem before comparison, then canonicalized, so
 * shell-mount spellings (`/mnt/c/...`, `/c/...`), separator direction, drive-letter case and 8.3
 * short names all compare equal. Resolving links is the load-bearing step: `canonicalize` does
 * NOT call realpath, so a directory symlink inside the root pointing out of it (`<root>/link` ->
 * `/other-project`) satisfies a purely lexical prefix test while naming a file the caller was
 * confined away from. A path whose leaf does not exist yet is resolved through
 * {@link resolveThroughLinks}, which follows the links on the part that DOES exist rather than
 * giving up on the whole path -- see that function for why the giving-up version was a hole.
 *
 * The trailing-separator guard is what stops `/srv/project-secrets` from reading as inside
 * `/srv/project`. Case is folded via foldPath, which asks the platform rather than assuming
 * Windows: a default macOS APFS volume is case-insensitive too, and folding only on Windows
 * rejected `--file /Users/alice/repo/x.ts` under a root git reports as `/Users/alice/Repo`.
 */

export function isInsideRoot(target: string, root: string): boolean {
  const rt = resolveThroughLinks(target);
  const rr = resolveThroughLinks(root);
  // Checked before the equality test below, which would otherwise read two unresolvable paths as
  // the same place.
  if (rt === UNRESOLVABLE_PATH || rr === UNRESOLVABLE_PATH) return false;
  const t = foldPath(normalizeForFs(rt));
  const r = foldPath(normalizeForFs(rr));
  if (t === r) return true;
  return t.startsWith(r.endsWith('/') ? r : r + '/');
}


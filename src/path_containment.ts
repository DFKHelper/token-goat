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

import { lowercaseDriveLetter, expandShortPath, normalizeDarwinSystemAlias, isUncOrDevicePath, WSL_PATH_RE, MSYS_PATH_RE } from './paths.js';

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
 * The case fold used to decide CONTAINMENT, and only that. ASCII A-Z, nothing else.
 *
 * `foldCase` is `toLowerCase()`, which folds by Unicode's rules. NTFS folds by its own `$UpCase`
 * table, and the two disagree. `U+212A` KELVIN SIGN lowercases to ASCII `k` in JavaScript, while
 * NTFS keeps `worK`(U+212A) and `work` as two different directories on disk. A containment check
 * that folds with Unicode therefore reads a real, distinct, OUTSIDE directory as the root itself
 * and admits everything under it -- reproduced 2026-09-13 on Windows 11 / NTFS, where an MCP `read`
 * with `projectRoot` = `<base>/work` returned the contents of `<base>/wor`+U+212A+`/secret.txt`,
 * and `grep` leaked the same file. There are ~100 other characters in this class (the long s, the
 * Kelvin sign, dotless and dotted I, various fullwidth and mathematical forms).
 *
 * Folding ASCII-only cannot create that error, because it makes strictly FEWER pairs of strings
 * compare equal than either table does: every pair it calls equal, both Unicode and `$UpCase` also
 * call equal. What it can do is refuse a legitimate read whose root and target differ in the case
 * of a non-ASCII letter (`/srv/Ärger` against a root spelled `/srv/ärger`), which is a refusal and
 * not a disclosure -- the direction a containment boundary is allowed to be wrong in.
 *
 * Deliberately NOT a change to `foldCase` itself: `db.ts` mirrors that one into SQL as `TG_LOWER`,
 * and the two must stay byte-identical or every stored path key silently stops matching its own
 * row. See `sql_path.ts`. This fold never touches an index key.
 */
export function foldCaseForContainment(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** {@link foldCaseForContainment}, applied only where the filesystem itself folds case. */
export function foldPathForContainment(p: string): string {
  return isCaseInsensitiveFs() ? foldCaseForContainment(p) : p;
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
 *
 * Only `\\?\` is stripped. `\\.\` is the device namespace, not a spelling of an ordinary path, and
 * stripping it turned `\\.\pipe\name` into the relative `pipe/name` -- which then got joined onto
 * whatever the walk was standing on, so the device refusal downstream never saw a device. It is
 * left as written, which makes it an absolute root that `isUncOrDevicePath` recognises.
 */
/** A drive letter with nothing after it, or with something that is not a separator: `Z:`, `Z:foo`. */
const DRIVE_RELATIVE_PATH = /^[a-z]:(?![\\/])/i;

function linkTarget(link: string): { root: string | null; segs: string[] } {
  const raw = link.replace(/\\/g, '/').replace(/^\/\/\?\/(UNC\/)?/i, (_m, unc: string | undefined) => (unc === undefined ? '' : '//'));
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
    // A DRIVE-RELATIVE target -- `Z:foo`, a drive letter with no separator after it -- is neither
    // absolute nor relative to the link's own directory. Windows resolves it against that drive's
    // own current directory, which is per-process state no Node API exposes, so this walk cannot
    // say where it lands. `linkTarget` read it as a segment literally NAMED `Z:foo` and appended it
    // to the directory the walk was standing on, which produced a path still inside the root: a
    // link out of the project therefore certified the project as containing it. Unresolvable is the
    // only honest answer, and every caller already fails closed on it.
    if (DRIVE_RELATIVE_PATH.test(link)) return UNRESOLVABLE_PATH;
    const target = linkTarget(link);
    if (target.root !== null) {
      // A link inside a local directory whose target is a share is refused here, before the next
      // `lstatSync` reaches it. That call is the whole point: on Windows a stat of `\\host\share`
      // opens an SMB connection, and this walk runs inside the pre-approval hook gate, so a link
      // planted in the workspace would make token-goat dial an address the model named while the
      // user was still being asked whether to allow the read -- the exact access the gate exists
      // to prevent, reached by a path that looks entirely local. `readlinkSync` above only reads
      // the link's own bytes, which is local, so the decision can be made before anything dials.
      //
      // Only an escape TO a share is refused, never a walk already on one: a project opened over
      // SMB is a legitimate setup, and refusing its own root would break it. Unresolvable rather
      // than false, because that is this function's word for "cannot answer safely", and every
      // caller already fails closed on it.
      //
      // The question is asked of `root`, the root the walk is standing on, not of the path as the
      // caller spelled it. Reading the spelling was wrong twice over: a relative path under a UNC
      // working directory is not spelled with a share and would have had a legitimate second share
      // refused, and a walk that has already followed a link onto a share would have kept refusing
      // afterwards. `root` is the resolved answer to both.
      //
      // A link onto a mapped drive letter -- `Z:\dir` where `Z:` is an SMB mapping -- is NOT
      // refused, and that is a decision rather than an oversight. Telling a mapped letter from a
      // local one needs a call that touches the drive, which is the thing being avoided, and the
      // threat is materially smaller: `\\host\share` lets a planted link name the host it dials,
      // while `Z:` reaches only wherever the user already chose to mount, so the worst case is a
      // slow stat of the user's own share rather than a connection to an attacker's address.
      if (!isUncOrDevicePath(root) && isUncOrDevicePath(target.root)) return UNRESOLVABLE_PATH;
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
 * Whether `target` reaches a network share once every link on it is followed -- decided WITHOUT
 * following any of them onto the network.
 *
 * A pre-approval gate that reads the spelling of a path answers a smaller question than the one it
 * is asked. `\\host\share\x` is refused by every caller of {@link isUncOrDevicePath}, but a
 * repository can check in an ordinary-looking directory as a symlink to that share, and then a
 * path spelled entirely in local characters -- `<repo>/vendor/notes.md` -- stats onto the network
 * anyway. The hook is running before the user has approved the call, so the SMB session and the
 * authentication attempt it carries are already spent by the time they say no.
 *
 * The walk is the same one containment uses, and it is network-free by construction: each segment
 * is `lstat`-ed, which does not follow, and a link's own bytes are read with `readlink`, which is
 * local -- so a link pointing at a share is recognised from the reparse point, before anything
 * dials. An unresolvable chain (unreadable ancestor, too many hops, an oversized path) answers
 * true: this is a gate, and "could not see" is not "safe".
 *
 * `cwd` resolves a relative target, and defaults to the process's own. A target already spelled as
 * a share short-circuits, so the walk is never started standing on one.
 */
export function escapesOntoNetworkThroughLinks(target: string, cwd?: string): boolean {
  if (isUncOrDevicePath(target)) return true;
  let absolute: string;
  try {
    absolute = path.resolve(cwd ?? process.cwd(), target);
  } catch {
    return true;
  }
  if (isUncOrDevicePath(absolute)) return true;
  const resolved = resolveThroughLinks(absolute);
  return resolved === UNRESOLVABLE_PATH || isUncOrDevicePath(resolved);
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
 * `/srv/project`. Case is folded via {@link foldPathForContainment}, which asks the platform rather
 * than assuming Windows -- a default macOS APFS volume is case-insensitive too, and folding only on
 * Windows rejected `--file /Users/alice/repo/x.ts` under a root git reports as `/Users/alice/Repo`
 * -- and which folds ASCII only, for the reason given on that function.
 */

export function isInsideRoot(target: string, root: string): boolean {
  // Before the walk, not inside it. `resolveThroughLinks` refuses a LINK that escapes onto a
  // share, and refuses it without dialling, but a target the caller simply spelled as a share
  // arrives with that share already as its root -- so the walk's first `lstatSync` opened the SMB
  // connection the refusal exists to prevent, to an address the model named, while the user was
  // still being asked whether to allow the read. The share the target names is compared against
  // the one the root names, so a project genuinely hosted over SMB still works and only a target
  // reaching a DIFFERENT share (or any share, from a local root) is refused.
  //
  // This closes the spelling, not every route to a server, and the difference is the point rather
  // than a caveat. A drive letter mapped to a share -- `Z:` bound to `\\host\share`, or a junction
  // pointing at one -- reads as local here and the walk below will still contact that server, and a
  // root that is itself a share is resolved because the target is allowed to be there. A mapped
  // letter reaches a host the person at the keyboard already mounted; `\\host\share` in a tool call
  // reaches any host the model can name, and that is the one being refused. Telling the two apart
  // needs a Windows call Node does not expose, so it is written down rather than claimed away.
  if (reachesForeignShare(target, root)) return false;
  const rt = resolveThroughLinks(target);
  const rr = resolveThroughLinks(root);
  // Checked before the equality test below, which would otherwise read two unresolvable paths as
  // the same place.
  if (rt === UNRESOLVABLE_PATH || rr === UNRESOLVABLE_PATH) return false;
  const nt = normalizeForFs(rt);
  const nr = normalizeForFs(rr);
  const t = foldPathForContainment(nt);
  const r = foldPathForContainment(nr);
  if (t !== r && !t.startsWith(r.endsWith('/') ? r : r + '/')) return false;
  // The fold is a claim about the FILESYSTEM, and the platform is a poor proxy for one. Windows
  // carries a per-directory case-sensitivity flag -- `fsutil file setCaseSensitiveInfo`, which WSL
  // sets on every directory it creates -- and macOS formats a case-sensitive APFS volume on
  // request. There, `C:\work\Repo` and `C:\work\repo` are two different directories, and folding
  // reads the second as the first: everything under a real, distinct, OUTSIDE directory is
  // admitted. Same disclosure as the Kelvin-sign fold that {@link foldCaseForContainment} exists to
  // stop, arriving by the other side of the same assumption.
  //
  // So the fold is trusted only where it changed nothing. Where it is what made the two sides
  // agree, the filesystem is asked: two spellings of the root that name the same directory
  // canonicalize to the same real path, and two that do not, do not.
  if (nt.slice(0, nr.length) === nr) return true;
  return sameDirectory(nt.slice(0, nr.length), nr);
}

/**
 * Whether `p` names a place reached over the network, rather than merely being spelled with two
 * leading slashes. `//server/share` and its `//?/UNC/server/share` device spelling are; the local
 * device spellings -- `//?/C:/work`, `//./C:/work`, `//?/Volume{...}/work` -- are not, and resolving
 * one of those costs a local `realpath` and no connection to anywhere.
 *
 * Split out from {@link isUncOrDevicePath}, which answers the wider question its callers want (does
 * this path need the two-leading-slash spelling handled at all). Refusing on the wider answer would
 * have declined a differently-cased drive-letter device path that can be checked for free.
 */
export function isNetworkPath(p: string, platform: string = process.platform): boolean {
  return networkShareRoot(p, platform) !== null;
}

/**
 * `\\host\share` for a path that names one, folded for comparison; `null` for anything else.
 *
 * Windows only, and that is a correctness bound rather than an optimisation. Two leading slashes
 * mean a share on Windows and nothing at all on Linux or macOS: POSIX leaves a leading `//`
 * implementation-defined and both of those resolve it to `/`, which Node agrees with --
 * `path.posix.normalize('//tmp/repo')` is `/tmp/repo`. Reading `//tmp/repo` as a share therefore
 * refused an ordinary local directory, and the platform is not detectable from the spelling on
 * those systems anyway: an SMB mount there sits at a perfectly ordinary path like `/mnt/share`.
 * The parameter exists so a test can ask the Windows question from any runner, which is the only
 * way the branch gets exercised on more than one of the three CI platforms.
 */
export function networkShareRoot(p: string, platform: string = process.platform): string | null {
  if (platform !== 'win32') return null;
  const device = /^[\\/]{2}([?.][\\/])?/.exec(p);
  if (device === null) return null;
  let rest = p.slice(device[0].length);
  if (device[1] !== undefined) {
    // `\\?\C:\work` is spelled like a share and is this volume, one local resolve away. Only the
    // `\\?\UNC\` spelling of a device path names a host.
    const unc = /^UNC[\\/]/i.exec(rest);
    if (unc === null) return null;
    rest = rest.slice(unc[0].length);
  }
  const [host = '', share = ''] = rest.split(/[\\/]/);
  return `//${foldCase(host)}/${foldCase(share)}`;
}

/**
 * Whether `target` names a share that `root` does not, which is the one case no walk may start on.
 *
 * Separate and exported so the decision can be asked of the Windows rules from a Linux or macOS
 * runner. Left inline it would be checked on one CI platform of three, and it is the platform that
 * skips which the whole branch is about.
 */
export function reachesForeignShare(target: string, root: string, platform: string = process.platform): boolean {
  const share = networkShareRoot(target, platform);
  return share !== null && share !== networkShareRoot(root, platform);
}

/**
 * Whether two spellings name the same directory on disk. False if either cannot be resolved.
 *
 * Exported for its tests and called from nowhere else: the share case is unreachable through
 * {@link isInsideRoot} on Windows without a real file server, and a security predicate that only
 * one of the three CI platforms can exercise is one that two of them certify blind.
 */
export function sameDirectory(a: string, b: string, platform: string = process.platform): boolean {
  // Reached only when the two spellings of the root differ and the FOLD is what made them agree,
  // so every answer here is about a name the caller did not write the way the root is written.
  // That is a narrow enough case to fail closed in, and failing closed is the only safe direction:
  // being wrong here discloses a file, and this runs before the user has approved the tool call.
  //
  // A share is not asked, because resolving one opens an SMB connection to an address the model
  // chose -- see `vscode_path_gate.ts` for the 21.0 s that cost. Unasked means refused, not
  // admitted: a case-sensitive SMB export really does keep `\\host\share\repo` and
  // `\\host\share\Repo` apart, and admitting the second on the platform's say-so is the same
  // disclosure this function exists to close, just where it cannot be checked. A UNC root spelled
  // the way it really is never arrives here at all -- the caller returns on the exact-prefix match
  // above -- so this refuses a differently-cased spelling of a share and nothing else.
  // `platform` is threaded from the caller for one reason: the branch is Windows-only and no CI
  // runner has a file server, so without it this line is exercised on one platform of three.
  if (isNetworkPath(a, platform) || isNetworkPath(b, platform)) return false;
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(b);
  } catch {
    // The ROOT is not on disk. There is no directory to compare against and no second directory to
    // be let into, so there is nothing this function can learn -- a project root that has not been
    // created yet, or a configured one that is simply gone. The platform's answer stands, which is
    // what every release before this one did in every case.
    return true;
  }
  try {
    return fs.realpathSync.native(a) === canonicalRoot;
  } catch {
    // The root resolves and the caller's spelling of it does not. On a case-insensitive volume it
    // would have resolved to the same directory, so this asymmetry IS the volume saying the two
    // names are different places -- and the one the caller wrote is not there. Admitting it would
    // let a create put a new directory outside the project, and an `EACCES` here says nothing at
    // all, which is the same "unreadable means inside" mistake the containment walk had removed
    // from it earlier in this release.
    return false;
  }
}


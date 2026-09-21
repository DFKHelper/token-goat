/** MCP (Model Context Protocol) stdio server exposing token-goat's surgical-read commands as tools, so any MCP-aware harness (VS Code, Copilot CLI, etc.) can call them in-process instead of shelling out to `token-goat <cmd>`. Every tool handler mirroring a CLI command is a thin adapter over the same `run*`/`runSemantic` functions the CLI commands in `cli.ts` call — no logic is duplicated, so a fix or format change to a surgical-read command applies to both surfaces automatically. The one exception is `index_status`, which has no CLI counterpart by design: it answers a question only an MCP client needs to ask (is an empty result "no match" or "index not ready?"), since CLI users have the hook layer and `doctor`/`stats` for the same signal. */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Type-only, so both are erased at compile time and neither reaches the bundle's import list. The runtime value is loaded inside createMcpServer -- see the note on that function.
import type { CallToolResult, McpServer } from './mcp_jsonrpc.js'

import { buildProjectMap, formatProjectMap, mapLookupBytesSaved } from './baseline.js'
import { claudeConfigDir } from './claude_config_dir.js'
import { ENV_KEYS, VERSION, dataDir, globalDbPath } from './constants.js'
import { envStrList } from './env.js'
import {
  runSymbol,
  runRead,
  runSection,
  runSkeleton,
  runOutline,
  runSemantic,
  runRefs,
  runBrief,
  runChanged,
  runGrep,
  runImports,
  runExports,
  findSpecSeparator,
  parseColonLineSpec,
  parseLineRange,
  ABSENT_PIN,
  ConfinementIdentityError,
  fileIdentity,
  pinKey,
  withPinnedReads,
} from './read_commands.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import {
  compressText,
  type CompressionResult,
  createHandoff,
  resolveHandoff,
  retrieveText,
  CONTENT_MAX_INPUT_CHARS,
} from './content_store.js'
import { resolveProjectRoot } from './project.js'
import { getProjectIndexCounts, getEmbeddingCoverage } from './index_health.js'
import { getDirtyPathsFor, isWorkerRunning } from './worker.js'
import { getDb } from './db.js'
import { embeddingsDepsAvailable, checkEmbeddingPreflight } from './embeddings.js'
import { loadConfig } from './config.js'
import { extractErrorMessage, foldCaseForContainment } from './util.js'
import { normalizePath, displaySafeJson } from './paths.js'

// The read_commands.ts handlers below are shared verbatim with the CLI (see the file-level doc comment), so their error/ambiguity/overflow text is written for a shell caller: literal `token-goat <cmd> "..."` retry commands and `--flag`-style CLI switches. An MCP client has no shell and no CLI flags -- only this tool's own JSON params -- so a model driving an MCP client would either try to shell out (which fails) or get stuck. Rewrite those CLI-only affordances into MCP-appropriate guidance (re-call this tool with an adjusted parameter) before wrapping the text into a CallToolResult, without touching read_commands.ts/ overflow_guard.ts's CLI-facing text at all -- the CLI's own output stays unchanged.
const TOKEN_GOAT_RETRY_RE = /token-goat (\w[\w-]*) "([^"]+)"/g

// Upper bounds for the MCP tools' numeric params, matching the `.max(CONTENT_MAX_INPUT_CHARS)` convention `compress_text` already uses. The `run*` handlers apply no upper clamp of their own (`limit`/`top` go straight into a SQL LIMIT, `maxLines` into a `.slice`), so an unbounded value there is mostly a no-op cap rather than an allocation; `context` is the one that genuinely amplifies, since every extra line is emitted per match.
const MCP_MAX_LIMIT = 1000
const MCP_MAX_CONTEXT_LINES = 50
const MCP_MAX_OUTPUT_LINES = 10_000

/** cmd -> the MCP tool param name that literal retry command's quoted argument maps to. */
const RETRY_PARAM_BY_COMMAND: Record<string, string> = {
  read: 'spec',
  section: 'spec',
  symbol: 'name',
  skeleton: 'file',
  outline: 'file',
}

/** Rewrites CLI-only affordances (shell retry commands, `--flag` switches) in `text` into MCP tool-call guidance. No-op on text that contains neither. */
function mcpFriendlyText(text: string): string {
  let out = text.replace(TOKEN_GOAT_RETRY_RE, (_match, cmd: string, arg: string) => {
    const param = RETRY_PARAM_BY_COMMAND[cmd] ?? 'parameter'
    return `the "${cmd}" tool again with a more specific ${param} (e.g. "${arg}")`
  })
  out = out.replace(/--json\b/g, 'the json parameter')
  out = out.replace(/--limit\b/g, 'the limit parameter')
  out = out.replace(/--top\b/g, 'the top parameter')
  out = out.replace(/--grep PATTERN, --section HEADING, or --tail N/g, 'a narrower query')
  return out
}

/** Wraps a `{ text, code }` result from a read_commands handler into an MCP `CallToolResult`. */
function toCallToolResult(result: { text: string; code: number }): CallToolResult {
  return {
    content: [{ type: 'text', text: mcpFriendlyText(result.text) }],
    isError: result.code !== 0,
  }
}

// VS Code Chat has no hook layer, so this tool is its entire compression surface: return the base64url payload only when inlining it is genuinely cheaper in tokens than the original text, otherwise the "compression" tool would inflate the very context it claims to shrink.
function compressionPayload(result: CompressionResult): Record<string, unknown> {
  if (result.inlineWins) return { ...result }
  const { compact: _compact, ...rest } = result
  return { ...rest, payloadWithheld: 'inlining the compact payload would cost more tokens than the original text; use the recovery command to retrieve it' }
}

function toRawCallToolResult(result: { text: string; code: number }): CallToolResult {
  return {
    content: [{ type: 'text', text: result.text }],
    isError: result.code !== 0,
  }
}

/** Captures everything written to `process.stdout`/`process.stderr` during `fn()`, in call order, restoring the original write functions before returning (even if `fn` throws). `runRefs`/`runChanged`/`runGrep`/`runImports`/`runExports` -- unlike the `{ text, code }`- returning handlers `toCallToolResult` adapts above -- print their own output via `emit()`/`emitErr()` (raw `process.stdout`/`process.stderr` writes) and return only an exit code, matching what their CLI callers (`runExit` in cli.ts) expect. An MCP stdio server speaks JSON-RPC over that SAME stdout stream, so letting one of them write raw text straight to the real `process.stdout` here would corrupt every in-flight MCP message, not just this tool's response -- this capture is what stands in for that missing return value, without touching read_commands.ts's printing behavior (which the CLI still depends on byte-for-byte). */
function captureOutput(fn: () => number): { code: number; text: string } {
  const chunks: string[] = []
  const record = (chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'))
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : typeof maybeCb === 'function' ? maybeCb : undefined
    if (typeof callback === 'function') callback()
    return true
  }
  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const origStderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = record as typeof process.stdout.write
  process.stderr.write = record as typeof process.stderr.write
  try {
    const code = fn()
    return { code, text: chunks.join('') }
  } finally {
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
  }
}

/** Adapts a `run*` handler that prints its own output and returns only an exit code (see {@link captureOutput}) into the same `CallToolResult` shape {@link toCallToolResult} produces for the `{ text, code }`-returning handlers. */
function toCallToolResultFromExitCode(fn: () => number): CallToolResult {
  const { code, text } = captureOutput(fn)
  return toCallToolResult({ text, code })
}

/** Filesystem admission gate for the MCP read tools. The CLI is deliberately unconfined -- `token-goat read /etc/passwd` is a legitimate thing for a human at a shell to do -- but the MCP tools are thin adapters over the same `run*` functions, so without this an MCP client inherits unrestricted filesystem read through them. Enforced here, in the MCP layer only; `read_commands.ts` is shared with the CLI and is left alone. Defense in depth, not a closed hole: a caller that can reach these tools can usually also call its harness's own read tool. This narrows one specific sink, it does not sandbox the agent. */
/** The real path of `p`, or `null` when this process could not determine it. ABSENT and UNREADABLE are different answers, and collapsing them into "return the caller's own spelling" was a fail-OPEN branch on a confinement boundary: a target whose real location could not be seen was then compared LEXICALLY, so a path that merely looks like it is under the root was admitted and opened. That is the identical defect {@link isInsideRoot} documents as removed from `path_containment.ts`; this second boundary never adopted the fix, and the two failed in opposite directions. ENOENT and ENOTDIR keep the lexical answer deliberately. A spec may name a file that does not exist, and that read must fail as an ordinary "could not read" rather than as a confinement refusal; the `ABSENT_PIN` that `confineTargets` writes for exactly this case is what keeps it honest if something is created at the path between validation and the read. Every other errno -- EACCES or EPERM on an untraversable ancestor, ELOOP on a symlink cycle, EIO -- means the answer is unknown, and unknown is not "inside". This deliberately does NOT rest on any claim that some path resolves for `open` but not for `realpathSync.native`. That divergence was asserted here for Windows reparse points and does not reproduce: measured 2026-09-13 on Windows 11 / Node 24 against three AppExecLink aliases under `%LOCALAPPDATA%\Microsoft\WindowsApps`, the likeliest candidate shape, `realpathSync.native`, `realpathSync` and `openSync` all answer EACCES alike. The rule holds without it: an errno this process cannot interpret is an answer it does not have, and a gate that guesses on one is the fail-open branch this function exists to remove. */
function realPathForContainment(p: string): string | null {
  try {
    return fs.realpathSync.native(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? p : null
  }
}

/** Case-folded on Windows, where the same directory has many valid spellings and a case-sensitive compare would reject legitimate in-root reads. ASCII only -- `toLowerCase()` folds pairs NTFS keeps apart, and that admits a real outside directory as the root; see {@link foldCaseForContainment}. */
function forCompare(p: string): string {
  return process.platform === 'win32' ? foldCaseForContainment(p) : p
}

/** CONFINEMENT INVARIANT: the base the gate resolves a relative target against MUST be the exact base the execution layer resolves it against. Every tool handler resolves the root exactly ONCE, here, and then uses that single absolute value for BOTH the {@link confineTargets} check and the `projectRoot` option handed to the `run*` handler. Resolving a second time inside the gate (as this file used to) let the two bases diverge: the gate validated `<projectRoot>/x` while the read resolved `<server cwd>/x`, so confinement was only sound when the server process's cwd happened to equal the project root. `resolveProjectRoot` also walks up to the git toplevel, so even an explicitly supplied `projectRoot` pointing at a subdirectory of a repo resolves to a different base than the raw value -- one resolution site is the only way to guarantee the two agree. */
function resolveToolRoot(projectRoot: string | undefined): string {
  const resolved = resolveProjectRoot(projectRoot !== undefined ? { project: projectRoot } : {})
  assertRootAllowed(resolved)
  return resolved
}

/** Thrown when a caller-supplied `projectRoot` resolves outside every entry in `mcp.allowed_roots`. The MCP SDK turns a handler throw into an error result for the caller, so the refusal still reaches whoever asked, and every tool gets it without each one remembering to ask. */
class RootNotAllowedError extends Error {}

/** Refuse a resolved root that the operator has not allowed. This check used to live inside {@link confineTargets}, which meant two things it should not have. Four tools -- `semantic`, `index_status`, `map` and `changed` -- resolve a caller-supplied root but read no individual file path, so they never call that function and were never checked at all: naming any directory on the machine returned its file inventory, headline symbols, indexed content chunks, or changed symbols and diff hunks, straight past the allowlist. And `confineTargets` returns early when `confine_reads_to_project_root` is off, so turning off the traversal guard silently voided the root allowlist for the other thirteen tools too, even though they are separate operator policies answering separate questions. Sitting on the one function that resolves a caller's root instead means a tool is covered by construction rather than by remembering, and the allowlist holds whatever the traversal guard is set to. Deliberately loadConfig() with NO argument -- the server's own config, never the caller-chosen root's -- which is the exact INVERSE of what mcp_server_confine_reads_config_scoping.test.ts pins for `confine_reads_to_project_root`. That is intentional: `confine_reads_to_project_root` is a workspace's policy about ITSELF, so it must be read from that workspace, while `allowed_roots` is the operator's policy about WHICH workspaces may be named at all, so reading it from the resolved root would let the root being restricted supply the setting that restricts it -- a repo could ship a project config listing itself and the allowlist would authorise the very root it exists to reject. */
/** Standard user skill directories, prompt assets, and transcript storage that token-goat permits for cross-workspace inspections. The two Claude Code entries hang off {@link claudeConfigDir}, which is `CLAUDE_CONFIG_DIR` when set and `<home>/.claude` otherwise, because that is how Claude Code itself resolves its config home: a user who relocates it keeps skills and transcripts there and nowhere else, so a hardcoded `~/.claude` named a tree the product no longer writes and these tools refused the only copy that exists. The relocated pair REPLACES the home-relative pair rather than joining it -- this is an allowlist on a confinement boundary, and the narrower set is the correct one when the wider one admits a directory Claude Code does not use; with the variable unset the two are the same path anyway. Always the named CHILDREN of the config home, never the config home itself: `CLAUDE_CONFIG_DIR=C:/` must grant `C:/skills` and `C:/projects`, not the whole drive. */
function getStandardAuxiliaryRoots(targetPath?: string): string[] {
  const home = os.homedir()
  const claudeHome = claudeConfigDir(home)
  const roots: string[] = [
    path.join(claudeHome, 'skills'),
    path.join(home, '.copilot', 'skills'),
    path.join(claudeHome, 'projects'),
    path.join(home, '.copilot', 'session-state'),
  ]
  const appData = process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming')
  roots.push(
    path.join(appData, 'Code', 'User', 'workspaceStorage'),
    path.join(appData, 'Code - Insiders', 'User', 'workspaceStorage'),
    path.join(appData, 'Cursor', 'User', 'workspaceStorage'),
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
    path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
    path.join(home, '.config', 'Code', 'User', 'workspaceStorage'),
    path.join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
    path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage'),
  )
  if (targetPath) {
    const norm = normalizePath(targetPath)
    const promptIdx = norm.toLowerCase().indexOf('/resources/app/extensions/')
    if (promptIdx !== -1) {
      roots.push(norm.slice(0, promptIdx + '/resources/app/extensions/'.length))
    }
  }
  return roots
}

function assertRootAllowed(resolvedRoot: string): void {
  const allowedRoots = loadConfig().mcp.allowed_roots
  if (allowedRoots.length === 0) return
  if (allowedRoots.some((allowed) => checkWithinProjectRoot(resolvedRoot, allowed).inside)) return
  if (getStandardAuxiliaryRoots(resolvedRoot).some((aux) => checkWithinProjectRoot(resolvedRoot, aux).inside)) return
  throw new RootNotAllowedError(
    `refused: "${resolvedRoot}" is not inside any root listed in mcp.allowed_roots. ` +
      'A caller-supplied projectRoot is untrusted input, so this deployment pins which roots may be named; ' +
      'add the root to mcp.allowed_roots (or TOKEN_GOAT_MCP_ALLOWED_ROOTS) to permit it.',
  )
}

/** Decides whether `target` resolves inside `resolvedRoot`, which must already be the absolute root produced by {@link resolveToolRoot} -- see the invariant documented there. Both sides go through `fs.realpathSync` first: a path that normalises inside the root but resolves through a symlink to somewhere outside it is the classic bypass, so the REAL path is compared against the REAL root, not the nominal one. Returns the resolved and real paths and the target's identity alongside the verdict, because a boolean is not enough to make the decision stick: resolving a path proves nothing about the object the read will later open, so the caller pins that object's identity. ORDER MATTERS. The identity stat is taken BEFORE the realpath the verdict is computed from, and that is not an accident. Stat last and a swap landing between the two calls would be validated in its pre-swap state but pinned in its post-swap state -- the pin would then certify the attacker's object as the one that passed the check, which is worse than no pin at all. Stat first and every ordering is safe: a swap before the stat is seen by the verdict and refused as out-of-root, a swap after it is caught by the identity comparison at open time. */
/** Why a containment check came out the way it did. `outside` is the ordinary refusal; the two `unresolvable-*` cases are also refusals, but they name a broken path rather than a traversal attempt, which is the difference between "fix your workspace" and "this tool is confined". */
type ContainmentReason = 'inside' | 'outside' | 'unresolvable-root' | 'unresolvable-target'

/** The outcome of one containment check. `pins` is the complete set of `pinKey -> identity` entries the caller must install, built HERE rather than by the caller. It has to be: which spellings of the target were validated is a fact only this function knows, and a caller that reconstructs the list from a couple of returned strings will miss one the moment this function starts validating another. It did. See the pin-coverage note at the end of the function. */
type ContainmentCheck = { readonly inside: boolean; readonly reason: ContainmentReason; readonly pins: readonly (readonly [string, string])[] }

/** No pins to install: every refusal path returns this, since nothing was admitted to pin. */
const NO_CHECK_PINS: readonly (readonly [string, string])[] = []

/** The `dev:ino` identity of `p`, or null when it cannot be stat'd -- absent, or on an unreadable parent. */
function identityOf(p: string): string | null {
  try {
    return fileIdentity(fs.statSync(p, { bigint: true }))
  } catch {
    return null
  }
}

/** Both map keys a validated spelling needs: the pre-realpath path and its realpath, since which one reaches the read helper depends on the handler. */
function pinsFor(abs: string, real: string, identity: string | null): readonly (readonly [string, string])[] {
  // ALWAYS pin, even when identity is null (the target couldn't be stat'd, i.e. it's absent): recording ABSENT_PIN is what stops "no map entry for this path" from meaning both "confinement is off" and "confined but unpinnable" -- without it, an in-root path validated as absent falls through to an unverified raw read the moment something is created there between validation and the read (see read_commands.ts's ABSENT_PIN and verifyStillAbsent).
  const pinIdentity = identity ?? ABSENT_PIN
  return [
    [pinKey(abs), pinIdentity],
    [pinKey(real), pinIdentity],
  ]
}

/** Exported for `tests/mcp_server_pins_the_spelling_the_reader_opens.test.ts`, which asserts the pin-coverage invariant this function is solely responsible for. It is the production entry point `confineTargets` calls, not a parallel copy: a test against a re-implementation would agree with the bug it is meant to catch, which is how the missing raw pin survived a green suite. */
export function checkWithinProjectRoot(target: string, resolvedRoot: string): ContainmentCheck {
  const rootReal = realPathForContainment(resolvedRoot)
  // Relative targets resolve against the project root, not the server process's cwd -- that is what the read_commands handlers themselves do with the same projectRoot this gate was handed, so resolving against cwd here would reject a legitimate relative spec whose read would have succeeded.
  const abs = path.resolve(resolvedRoot, normalizePath(target))
  // The caller's spelling, resolved without normalisation. This is what the handler forwards and therefore what the read layer opens, so it is BOTH the second containment check below and the path whose identity is worth recording.
  const absRaw = path.resolve(resolvedRoot, target)
  // Exactly ONE stat, and it is of the raw spelling. One, because the count is load-bearing: every additional stat between this point and the read is another window an attacker can swap the target in, and the ordering argument above only holds for a stat that precedes the realpath calls. A second stat added here for the normalized spelling reopened precisely that window, and the negative-pin race tests caught it. Of the raw spelling, because that is the object the read will open. Where normalisation changed the string the two spellings can in principle name different files -- both inside the root, since both are checked -- and then the normalized key carries the raw file's identity. A read that somehow resolved to the normalized spelling would fail its identity comparison and refuse: wrong-but-closed, which is the direction a confinement gate is allowed to be wrong in. A target that does not exist (or cannot be stat'd) yields no identity: a spec may legitimately name a missing file, and that read must fail as an ordinary "could not read" rather than be refused as a swap. `pinsFor` still records it, as ABSENT.
  const identity = identityOf(absRaw)
  // The realpath is computed ONCE here and handed back, so the caller can key a pin on it without a second realpathSync -- this gate's syscall cost stays at one stat plus one realpath per target.
  const realNative = realPathForContainment(abs)
  // Fail CLOSED when either side is unresolvable. Neither can be compared to anything: the only string available is the caller's own spelling, and admitting a path because it LOOKS like it is under the root is what this gate exists to prevent. `real` still reports the caller's spelling so the refusal message names the path the caller asked for. Which side failed is reported, not just that one did. Collapsing both into the ordinary out-of-root refusal tells an operator whose workspace root has become unreadable -- an unmounted share, a deleted cwd, a permission change on a parent -- that the file they asked for is outside their project, which sends them looking for a traversal that never happened.
  if (rootReal === null) return { inside: false, reason: 'unresolvable-root', pins: NO_CHECK_PINS }
  if (realNative === null) return { inside: false, reason: 'unresolvable-target', pins: NO_CHECK_PINS }
  const root = forCompare(normalizePath(rootReal))
  const under = (real: string): boolean => {
    const r = forCompare(normalizePath(real))
    return r === root || r.startsWith(root.endsWith('/') ? root : root + '/')
  }
  if (!under(realNative)) return { inside: false, reason: 'outside', pins: NO_CHECK_PINS }

  // The spelling CHECKED above is the normalized one. The spelling the handler forwards, and that the read layer therefore resolves, is the caller's raw one -- `confineTargets` passes the argument through byte-for-byte on purpose, so that a normalisation step here cannot validate a different string than the one that gets read. That protects against the gate being LOOSER than the reader. It does nothing about the reverse, and the reverse is reachable: `normalizePath` rewrites the WSL mount form `/mnt/c/x` to `c:/x` on every platform, deliberately, because a WSL process emits that form on Linux (see shellMountToWindowsPath). On POSIX `c:/x` is a RELATIVE path, so the gate resolved `/mnt/c/Users/victim/.ssh/id_rsa` to `<root>/c:/Users/...` and approved it, while the reader kept the absolute original and read the real file. The identity pin did not help: it was keyed on the spelling the gate invented, so the read's lookup missed and degraded to an unpinned raw read. So both spellings are required to land inside. The second resolution is skipped whenever normalisation was a no-op for `path.resolve`, which is the ordinary case.
  if (absRaw === abs) return { inside: true, reason: 'inside', pins: pinsFor(abs, realNative, identity) }

  const realRaw = realPathForContainment(absRaw)
  if (realRaw === null) return { inside: false, reason: 'unresolvable-target', pins: NO_CHECK_PINS }
  if (!under(realRaw)) return { inside: false, reason: 'outside', pins: NO_CHECK_PINS }

  // BOTH spellings get pinned, each with its own identity, and this is the whole reason `pins` is built here instead of by the caller. The read layer resolves the RAW target, so `pinKey(absRaw)` is the key it looks up; pinning only the normalized spelling left that lookup missing, and a miss does not fail closed -- it degrades silently to an unpinned raw read, switching off the identity check and the ABSENT_PIN race guard for the whole request while the gate still reported success. That is not a hypothetical for the WSL mount form: with a project root of `/mnt/c/workspace`, an ordinary in-root target `/mnt/c/workspace/a.txt` normalizes to the synthetic `/mnt/c/workspace/c:/workspace/a.txt`, which nothing ever opens, so EVERY read under such a root was unpinned (measured on Linux, 2026-09-13). Both share the one identity stat'd above, for the reason given there.
  return { inside: true, reason: 'inside', pins: [...pinsFor(abs, realNative, identity), ...pinsFor(absRaw, realRaw, identity)] }
}

/** The file portion of one `read`/`section` spec: `file::symbol`, `file@N-M`, `file:N-M`, or a bare path. Reuses read_commands.ts's own {@link parseLineRange} and {@link findSpecSeparator} instead of restating their grammar here, so this gate's notion of "the file part" agrees with the execution layer's by construction. Two hand-kept-in-sync regexes previously drifted apart on both syntaxes they cover: an `@` suffix that parseLineRange would decline (no trailing digits, a `::` in the prefix, or a literal file that happens to contain `@`) was still stripped here, validating a shorter in-root prefix while runRead resolved the untouched, longer, possibly out-of-root spec; and a spec with two `::` occurrences split on the FIRST one here but the LAST one in findSpecSeparator (used by both runRead and runSection), so `a::../../b::c` was validated as `a` while `a::../../b` was actually read. When in doubt, this returns the more inclusive (longer) string, never a shortened prefix -- see parseLineRange/findSpecSeparator for the precedence (`@`-range first, then the `:N`/`:N-M` region spec, matching runRead's own check order). */
function specFilePart(spec: string): string {
  const range = parseLineRange(spec)
  if (range !== null) return range.file
  const region = parseColonLineSpec(spec)
  if (region !== null) return region.file
  const colonIdx = findSpecSeparator(spec)
  return colonIdx === -1 ? spec : spec.slice(0, colonIdx)
}

/** Either every target passed confinement (`targets` is what the caller must forward to its `run*` call, `pins` what it must install around it via {@link withConfinedRead}), or the call is refused. */
type ConfinementResult =
  | { readonly ok: true; readonly targets: readonly string[]; readonly pins: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly refusal: CallToolResult }

// Shared empty pin set for the confinement-disabled path, so `withPinnedReads` installs a map that can never match and the read helpers stay on their unmodified branch. A frozen-by-convention module constant rather than a fresh Map per call: it is only ever read.
const NO_PINS: ReadonlyMap<string, string> = new Map<string, string>()

/** CONFINEMENT INVARIANT: a handler must pass `targets` from this function's own return value to its `run*` call, never the raw argument it validated -- the value checked and the value used must be the same reference, or a future normalisation step (trim, comma-strip, `@`/`::` parsing -- four such variants have shipped and been fixed individually in this function's history) reintroduces the bypass by construction. Comma-separated multi-file specs are checked part by part: one out-of-root member must reject the whole call, or the confinement is trivially bypassed by appending an in-root path. Each part is validated and forwarded byte-for-byte identical -- no trimming: `specFilePart`, and the `parseReadSpec`/`resolveSymbolSpec` execution layer it mirrors, never trim either, so trimming here would (as it did) validate a different string than the one that gets read. */
/** The refusal a failed containment check produces. All three are refusals and all three are final -- the distinction is diagnostic, not a difference in what the tool will do. A blocked read caused by an unreadable workspace root used to arrive worded as a traversal refusal, which is the one message guaranteed to send an operator hunting for an attack instead of at their mount. */
function refusalText(file: string, resolvedRoot: string, reason: ContainmentReason): string {
  const escapeHatch = 'Set mcp.confine_reads_to_project_root = false (or TOKEN_GOAT_MCP_CONFINE_READS=0) to allow cross-root reads.'
  if (reason === 'unresolvable-root') {
    return (
      `refused: the project root "${resolvedRoot}" could not be resolved, so no path can be confirmed to sit inside it. ` +
      'This is a broken workspace root -- an unmounted share, a deleted directory, or a permission change on a parent -- not a request to read outside the project.'
    )
  }
  if (reason === 'unresolvable-target') {
    return (
      `refused: "${file}" could not be resolved to a real location, so it cannot be confirmed to sit inside the project root. ` +
      'A symlink loop, a permission error on a parent directory, or a path past the operating system\'s length limit all produce this. ' +
      'The check fails closed rather than falling back to comparing the text of the path.'
    )
  }
  // Names the root rather than saying "the workspace", and says whose choice it was. The old wording -- "the MCP tools are confined to the workspace" -- described a boundary that only exists once an operator sets `mcp.allowed_roots`, which defaults to empty (config.ts). Until then the caller picks the root per call, so what this refusal proves is that the target did not sit inside the root THIS call named, not that the tools cannot reach outside some workspace. An operator reading the old sentence in a log would have taken the stronger guarantee from it.
  const rootScope =
    loadConfig().mcp.allowed_roots.length === 0
      ? 'Each call is confined to the projectRoot it names, and that root comes from the caller: set mcp.allowed_roots (or TOKEN_GOAT_MCP_ALLOWED_ROOTS) to pin which roots may be named at all.'
      : 'Each call is confined to the projectRoot it names, which must itself sit inside mcp.allowed_roots.'
  return `refused: "${file}" is outside the project root "${resolvedRoot}". ${rootScope} ${escapeHatch}`
}

function confineTargets(targets: readonly string[], resolvedRoot: string, splitCommas = true): ConfinementResult {
  // The allowlist is NOT checked here any more -- it moved to assertRootAllowed, called from resolveToolRoot, so it applies to every tool and is independent of this setting. See its doc comment for what that early return used to void.
  if (!loadConfig(resolvedRoot).mcp.confine_reads_to_project_root) return { ok: true, targets, pins: NO_PINS }
  const allowedRoots = loadConfig().mcp.allowed_roots
  const checked: string[] = []
  const pins = new Map<string, string>()
  for (const raw of targets) {
    const parts = splitCommas ? raw.split(',') : [raw]
    for (const part of parts) {
      const file = specFilePart(part)
      if (file === '') continue
      let check = checkWithinProjectRoot(file, resolvedRoot)
      if (!check.inside) {
        for (const allowed of allowedRoots) {
          const altCheck = checkWithinProjectRoot(file, allowed)
          if (altCheck.inside) {
            check = altCheck
            break
          }
        }
      }
      if (!check.inside) {
        for (const aux of getStandardAuxiliaryRoots(file)) {
          const auxCheck = checkWithinProjectRoot(file, aux)
          if (auxCheck.inside) {
            check = auxCheck
            break
          }
        }
      }
      if (!check.inside) {
        return { ok: false, refusal: toCallToolResult({ text: refusalText(file, resolvedRoot, check.reason), code: 1 }) }
      }
      // Pin what was just validated, so the read can prove it opened that same object rather than a replacement swapped in behind the path afterwards. The set of keys comes from the check itself: it is the only thing that knows which spellings of the target it resolved, and a lookup that misses degrades silently to the unpinned behaviour rather than failing closed.
      for (const [key, identity] of check.pins) pins.set(key, identity)
    }
    checked.push(splitCommas ? parts.join(',') : parts[0]!)
  }
  return { ok: true, targets: checked, pins }
}

/** Runs a gated handler body with the gate's identity pins installed, converting a swap detected at open time into the same shape of refusal an out-of-root target gets. The conversion is not cosmetic: without it a detected bypass escapes the tool as an unhandled MCP protocol error rather than a confinement decision the client can read. */
function withConfinedRead(pins: ReadonlyMap<string, string>, fn: () => CallToolResult): CallToolResult {
  try {
    return withPinnedReads(pins, fn)
  } catch (err) {
    if (err instanceof ConfinementIdentityError) {
      return toCallToolResult({
        text:
          `${err.message} The MCP tools are confined to the workspace. ` +
          'Set mcp.confine_reads_to_project_root = false (or TOKEN_GOAT_MCP_CONFINE_READS=0) to allow cross-root reads.',
        code: 1,
      })
    }
    throw err
  }
}

/** Builds the MCP server and registers every tool listed in tests/mcp_server.test.ts's TOOL_NAMES, which is asserted against a live listTools() call. Does not connect a transport. Async purely so the protocol layer and `zod` load here rather than at module scope. cli.ts already defers this whole module behind `await import('./mcp_server.js')` and says so, but that only defers token-goat's own code: a static `import` of a package gets hoisted to the top of the bundle, where ESM evaluates it before anything runs, and code splitting can only keep a module out of the startup chunk if the edge reaching it is dynamic. This once cost 181ms and 131 module file loads on every invocation of the binary -- `--version`, every hook Claude Code fires on every tool call, every test that spawns the bundle -- to serve the one command that is an MCP server. Keep both loads inside this function; a static import here is not local to this file. */
/** The set of tools to register, from `TOKEN_GOAT_MCP_TOOLS`, or null to register everything. Every tool's name, description, and full JSON input schema is sent to the model on every single request for the life of the session -- measured on this server's own `tools/list` output, the full surface is ~16 KB, roughly 4k tokens, and the schemas outweigh the descriptions. A harness using token-goat for two or three lookups pays for all eighteen. This is the lever for that, and it is a filter rather than a redesign because trimming descriptions is the wrong cut: they are what steers a model to the right tool, and a surface that is cheap and unusable costs more than one that is expensive and correct. Deny by omission: an unknown name can only fail to match a tool, never invent one, so a typo shrinks the surface rather than widening it. That failure is silent by nature -- a smaller tool list looks exactly like a correctly-filtered one -- so an unmatched name is reported on stderr (never stdout, which carries the JSON-RPC stream). An empty or whitespace-only value is treated as unset rather than as "register nothing": a server with zero tools is useless, so that value is far more likely an unset variable expanding to nothing than a deliberate request for a dead server. */
export function mcpToolAllowlist(): Set<string> | null {
  const names = envStrList(ENV_KEYS.MCP_TOOLS, [], ',')
  return names.length === 0 ? null : new Set(names)
}

export async function createMcpServer(): Promise<McpServer> {
  const [{ McpServer }, { z }] = await Promise.all([import('./mcp_jsonrpc.js'), import('zod')])
  const server = new McpServer({ name: 'token-goat', version: VERSION })

  // Applied by wrapping `registerTool` rather than guarding each of the registration calls below. A per-call guard is a list that has to be extended by hand every time a tool is added, and the omission ships silently -- the new tool simply ignores the allowlist and nobody sees it. Here a tool cannot be registered without passing the filter, so a tool added later is covered by construction rather than by remembering.
  const allowlist = mcpToolAllowlist()
  if (allowlist !== null) {
    const matched = new Set<string>()
    const registerAll = server.registerTool.bind(server)
    server.registerTool = ((name: string, definition: never, handler: never) => {
      if (!allowlist.has(name)) return
      matched.add(name)
      registerAll(name, definition, handler)
    }) as typeof server.registerTool
    // Deferred one tick so it runs after every registration below, and reported at startup rather than at exit: a stdio server lives as long as its client, so a typo surfaced on shutdown is one the operator debugs for the whole session first. `unref` so this never holds the process open on its own.
    setTimeout(() => {
      const unmatched = [...allowlist].filter((n) => !matched.has(n))
      if (unmatched.length > 0) {
        process.stderr.write(`token-goat: ${ENV_KEYS.MCP_TOOLS} names no such tool: ${unmatched.join(', ')}\n`)
      }
    }, 0).unref()
  }

  const makeProjectRootField = (verb: string) =>
    z
      .string()
      .optional()
      .describe(
        `absolute path to the workspace root to scope this ${verb} to; defaults to the MCP server process's cwd, ` +
          'which is not always the actual workspace root for MCP clients -- pass this explicitly when it might differ',
      )
  const projectRootField = makeProjectRootField('lookup')

  server.registerTool(
    'symbol',
    {
      description: 'Search for a symbol by name across the indexed project.',
      inputSchema: {
        name: z.string().describe('symbol name to search for'),
        limit: z.number().int().positive().max(MCP_MAX_LIMIT).optional().describe('max results (default: 20)'),
        file: z.string().optional().describe('restrict to one file'),
        kind: z.string().optional().describe('restrict to one kind (function, class, ...)'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { name, limit, file, kind, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      let confinedFile = file
      let pins = NO_PINS
      if (file !== undefined) {
        const gate = confineTargets([file], root)
        if (!gate.ok) return gate.refusal
        confinedFile = gate.targets[0]
        pins = gate.pins
      }
      return withConfinedRead(pins, () =>
        toCallToolResult(
          runSymbol({
            name,
            limit: limit ?? 20,
            ...(confinedFile !== undefined ? { file: confinedFile } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(json === true ? { json: true } : {}),
            projectRoot: root,
          }),
        ),
      )
    },
  )

  server.registerTool(
    'read',
    {
      description:
        "Read one symbol's full body, given a spec of the form file::symbol, or a line range file@N-M / file@N, or a bare file path. " +
        'Pass a comma-separated spec (file::a,b) to fetch several symbols\' bodies from one file in a single call.',
      inputSchema: {
        spec: z.string().describe('file::symbol, file@N-M, file@N, a bare file path, or comma-separated file::a,b for a merged multi-symbol view'),
        json: z.boolean().optional().describe('output as JSON'),
        forceRefresh: z.boolean().optional().describe('reparse file from disk before querying (ignore stale index)'),
        stats: z.boolean().optional().describe('add per-symbol reference count and doc-coverage flag'),
        projectRoot: projectRootField,
      },
      // What readOnlyHint claims here, once, for all fifteen tools that carry it: the caller's own environment is untouched -- the project's files, and anything the caller would notice missing. Three things these tools do are deliberately outside that. They append a row to token-goat's `stats` table. They may reparse a file whose index entry is stale, and enqueue it for the background indexer. Opening a database for the first time creates its schema. All three are token-goat's own derived state, rebuilt from the project on demand and worth nothing if deleted; calling a symbol lookup a writing tool on their account would cost the caller a confirmation prompt for every read while protecting nothing. A tool that touches anything the caller owns says so instead, and the guard beside this file measures which tools those are rather than trusting the claim.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { spec, json, forceRefresh, stats, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const gate = confineTargets([spec], root)
      if (!gate.ok) return gate.refusal
      return withConfinedRead(gate.pins, () =>
        toCallToolResult(
          runRead({
            spec: gate.targets[0]!,
            ...(json === true ? { json: true } : {}),
            ...(forceRefresh === true ? { forceRefresh: true } : {}),
            ...(stats === true ? { stats: true } : {}),
            projectRoot: root,
          }),
        ),
      )
    },
  )

  server.registerTool(
    'section',
    {
      description: 'Read one section from a file, given a spec of the form file::Heading.',
      inputSchema: {
        spec: z.string().describe('file::Heading'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { spec, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const gate = confineTargets([spec], root)
      if (!gate.ok) return gate.refusal
      return withConfinedRead(gate.pins, () =>
        toCallToolResult(
          runSection({
            spec: gate.targets[0]!,
            ...(json === true ? { json: true } : {}),
            projectRoot: root,
          }),
        ),
      )
    },
  )

  server.registerTool(
    'skeleton',
    {
      description: 'List all symbols in a file without bodies (name, kind, line range).',
      inputSchema: {
        file: z.string().describe('file path'),
        json: z.boolean().optional().describe('output as JSON'),
        minLines: z.number().int().optional().describe('only show symbols at least N lines long'),
        forceRefresh: z.boolean().optional().describe('reparse file from disk before querying (ignore stale index)'),
        stats: z.boolean().optional().describe('add per-symbol reference count and doc-coverage flag'),
        projectRoot: projectRootField,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { file, json, minLines, forceRefresh, stats, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const gate = confineTargets([file], root)
      if (!gate.ok) return gate.refusal
      return withConfinedRead(gate.pins, () =>
        toCallToolResult(
          runSkeleton({
            file: gate.targets[0]!,
            ...(json === true ? { json: true } : {}),
            ...(minLines !== undefined ? { minLines } : {}),
            ...(forceRefresh === true ? { forceRefresh: true } : {}),
            ...(stats === true ? { stats: true } : {}),
            projectRoot: root,
          }),
        ),
      )
    },
  )

  server.registerTool(
    'outline',
    {
      description: 'List symbols in a file with line ranges and docstrings.',
      inputSchema: {
        file: z.string().describe('file path'),
        json: z.boolean().optional().describe('output as JSON'),
        minLines: z.number().int().optional().describe('only show symbols at least N lines long'),
        forceRefresh: z.boolean().optional().describe('reparse file from disk before querying (ignore stale index)'),
        stats: z.boolean().optional().describe('add per-symbol reference count and doc-coverage flag'),
        projectRoot: projectRootField,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { file, json, minLines, forceRefresh, stats, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const gate = confineTargets([file], root)
      if (!gate.ok) return gate.refusal
      return withConfinedRead(gate.pins, () =>
        toCallToolResult(
          runOutline({
            file: gate.targets[0]!,
            ...(json === true ? { json: true } : {}),
            ...(minLines !== undefined ? { minLines } : {}),
            ...(forceRefresh === true ? { forceRefresh: true } : {}),
            ...(stats === true ? { stats: true } : {}),
            projectRoot: root,
          }),
        ),
      )
    },
  )

  server.registerTool(
    'semantic',
    {
      description:
        'Semantic search over the indexed project (falls back to full-text search when no embedding index is available). ' +
        'Scoped to projectRoot if given, else the MCP server process\'s own cwd -- which may not be the actual workspace ' +
        'root for a client that launched the server from elsewhere, so pass projectRoot explicitly when in doubt.',
      inputSchema: {
        query: z.string().describe('natural-language search query'),
        limit: z.number().int().positive().max(MCP_MAX_LIMIT).optional().describe('max results (default: 20)'),
        grep: z.string().optional().describe('filter to hits whose file path matches this regex (literal substring if it does not compile as regex); matched against the path as rendered, same convention as refs --grep'),
        excludeTests: z.boolean().optional().describe('hide hits whose file is a test file (opt-in; default output is unchanged)'),
        preflight: z.boolean().optional().describe('run semantic embedding preflight check and return status'),
        warm: z.boolean().optional().describe('warm up the embedding model session in memory before query execution'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: makeProjectRootField('search'),
      },
      // openWorldHint stays false although a first call on a machine with no cached model downloads one over the network: what this tool interacts with is the local index, and the download provisions the tool rather than being the tool reaching out. A client reading `true` here would take it as "this searches the internet", which is the wrong warning.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const { query, limit, grep, excludeTests, preflight, warm, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      return toCallToolResult(
        await runSemantic(query, {
          ...(limit !== undefined ? { limit } : {}),
          ...(grep !== undefined ? { grep } : {}),
          ...(excludeTests === true ? { excludeTests: true } : {}),
          ...(preflight === true ? { preflight: true } : {}),
          ...(warm === true ? { warm: true } : {}),
          ...(json === true ? { json: true } : {}),
          projectRoot: root,
        }),
      )
    },
  )

  server.registerTool(
    'index_status',
    {
      description:
        'Report whether the index for a project can be trusted right now: whether it has ever been indexed at all, ' +
        'current file/symbol counts, dirty-reindex-queue depth, whether the background worker is alive, and whether ' +
        'embeddings are available (semantic silently degrades to full-text search without them). Call this after an ' +
        'unexpectedly empty result from another token-goat tool (symbol/read/semantic/refs/brief/...) to tell apart ' +
        '"no match" from "the index is not ready yet" -- an MCP-only client has no hook layer to warn about this on ' +
        'its own, so an empty tool result and a stale/unindexed project look identical without this check.',
      inputSchema: {
        projectRoot: makeProjectRootField('check'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const { projectRoot } = args
      const rootDir = resolveToolRoot(projectRoot)
      const dbPath = globalDbPath()
      const databaseExists = fs.existsSync(dbPath)

      let fileCount = 0
      let symbolCount = 0
      let queryError: string | undefined
      if (databaseExists) {
        try {
          const counts = getProjectIndexCounts(dbPath, rootDir)
          fileCount = counts.fileCount
          symbolCount = counts.symbolCount
        } catch (err) {
          queryError = extractErrorMessage(err)
        }
      }

      const resolvedDataDir = dataDir()
      const dirtyQueueDepth = getDirtyPathsFor(resolvedDataDir).length
      const workerAlive = isWorkerRunning(resolvedDataDir)

      let embeddingsAvailable = false
      let coverage: { indexedFiles: number; embeddedFiles: number } | undefined
      if (databaseExists && queryError === undefined) {
        try {
          embeddingsAvailable = embeddingsDepsAvailable(getDb(dbPath))
          coverage = getEmbeddingCoverage(dbPath, rootDir)
        } catch {
          embeddingsAvailable = false
        }
      }
      const embeddingsEnabled = loadConfig(rootDir).indexing?.embeddings_enabled ?? true
      const preflight = await checkEmbeddingPreflight({
        projectRoot: rootDir,
        ...(coverage !== undefined ? { coverage } : {}),
      })

      const status = {
        projectRoot: rootDir,
        databaseExists,
        indexedForProject: fileCount > 0,
        fileCount,
        symbolCount,
        ...(queryError !== undefined ? { queryError } : {}),
        dirtyQueueDepth,
        workerAlive,
        embeddingsEnabled,
        embeddingsAvailable,
        embeddingPreflight: preflight.status,
        embeddingPreflightSummary: preflight.summary,
        ...(preflight.actionRequired !== undefined ? { embeddingPreflightAction: preflight.actionRequired } : {}),
      }
      return toCallToolResult({ text: displaySafeJson(status), code: 0 })
    },
  )

  server.registerTool(
    'refs',
    {
      description:
        'Find references to one or more symbols (spec: file::symbol, symbol, or comma-separated a,b,c / file::a,b for a merged multi-symbol view). ' +
        'For an unambiguous TypeScript symbol, automatically type-resolves candidates via the TypeScript compiler API to drop same-named-different-symbol ' +
        'false positives; falls back to name-based matching when that is not possible.',
      inputSchema: {
        spec: z.string().describe('file::symbol, symbol, or comma-separated a,b,c / file::a,b for a merged multi-symbol view'),
        callers: z.boolean().optional().describe('group references by their enclosing caller symbol'),
        limit: z.number().int().positive().max(MCP_MAX_LIMIT).optional().describe('max results'),
        top: z
          .number()
          .int()
          .positive()
          .max(MCP_MAX_LIMIT)
          .optional()
          .describe(
            'for a high-fanout symbol, group references by file (count only) and show only the top N files by reference count instead of a per-line dump',
          ),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { spec, callers, limit, top, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const gate = confineTargets([spec], root)
      if (!gate.ok) return gate.refusal
      return withConfinedRead(gate.pins, () =>
        toCallToolResultFromExitCode(() =>
          runRefs({
            spec: gate.targets[0]!,
            ...(callers === true ? { callers: true } : {}),
            ...(json === true ? { json: true } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(top !== undefined ? { top } : {}),
            projectRoot: root,
          }),
        ),
      )
    },
  )

  server.registerTool(
    'brief',
    {
      description:
        'One-shot symbol orientation: signature, location, token count, body, callers, and containing doc section, in a single call ' +
        '(spec: file::symbol; comma-separated file::a,b for a merged multi-symbol view; cross-file a.ts::x,b.ts::y is also supported -- ' +
        'unlike refs, a bare symbol name with no file is not accepted). ' +
        'Prefer this over separate read + refs calls when the goal is to understand a symbol, not just fetch its source: it folds the ' +
        'work of read (body) and refs --callers (call sites) into one result, at a fraction of the combined round-trip cost.',
      inputSchema: {
        spec: z
          .string()
          .describe('file::symbol; comma-separated file::a,b for a merged multi-symbol view; cross-file a.ts::x,b.ts::y is also supported'),
        limit: z.number().int().positive().max(MCP_MAX_LIMIT).optional().describe('max callers to show (default: 20)'),
        json: z.boolean().optional().describe('output as JSON'),
        context: z.number().int().nonnegative().max(MCP_MAX_CONTEXT_LINES).optional().describe('lines of call-site source to show before and after each caller (default 0)'),
        excludeTests: z.boolean().optional().describe('hide callers whose call site lives in a test file (opt-in; default output is unchanged)'),
        grep: z.string().optional().describe('only show callers whose enclosing symbol name matches this regex (literal substring if it is not valid regex)'),
        projectRoot: makeProjectRootField('orient'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { spec, limit, json, context, excludeTests, grep, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const gate = confineTargets([spec], root)
      if (!gate.ok) return gate.refusal
      return withConfinedRead(gate.pins, () =>
        toCallToolResultFromExitCode(() =>
          runBrief({
            spec: gate.targets[0]!,
            ...(json === true ? { json: true } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(context !== undefined ? { context } : {}),
            ...(excludeTests === true ? { excludeTests: true } : {}),
            ...(grep !== undefined ? { grep } : {}),
            projectRoot: root,
          }),
        ),
      )
    },
  )

  server.registerTool(
    'map',
    {
      description: 'Project overview: file count, languages, headline symbols, and recently modified files.',
      inputSchema: {
        compact: z.boolean().optional().describe('compact, low-token summary'),
        projectRoot: makeProjectRootField('overview'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { compact, projectRoot } = args
      const map = buildProjectMap(resolveToolRoot(projectRoot), { compact: compact === true })
      const text = formatProjectMap(map, map.compact)
      // buildProjectMap/formatProjectMap don't self-report the way the run*() handlers above do, so this replicates cmdMap's stat-recording wiring in cli.ts (see project_runchanged_missing_stat / map_lookup) locally rather than importing cmdMap itself, since cmdMap also owns process.exitCode/stdout side effects this tool must not perform. The byte accounting -- and the recentFiles-vs-topSymbols path canonicalization the dedup depends on, which stays correct even when projectRoot differs from this server process's cwd -- lives in mapLookupBytesSaved, shared with cmdMap so the two accountings cannot drift.
      const bytesSaved = mapLookupBytesSaved(map, text)
      recordStat('map_lookup', bytesSaved, savedTokensFromBytes(bytesSaved))
      return toCallToolResult({ text, code: 0 })
    },
  )

  server.registerTool(
    'changed',
    {
      description: 'List files or symbols changed since a git ref.',
      inputSchema: {
        ref: z.string().optional().describe('git ref to compare against (default: HEAD~5)'),
        symbolMode: z.boolean().optional().describe('list symbols instead of files'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { ref, symbolMode, json, projectRoot } = args
      return toCallToolResultFromExitCode(() =>
        runChanged({
          ...(ref !== undefined ? { ref } : {}),
          ...(symbolMode === true ? { symbolMode: true } : {}),
          ...(json === true ? { json: true } : {}),
          projectRoot: resolveToolRoot(projectRoot),
        }),
      )
    },
  )

  server.registerTool(
    'grep',
    {
      description: 'Regex search over files, caching nothing (session-aware grep).',
      inputSchema: {
        pattern: z.string().describe('regex pattern to search for'),
        path: z.array(z.string()).optional().describe('files or directories to search; defaults to this server process\'s cwd'),
        maxLines: z.number().int().positive().max(MCP_MAX_OUTPUT_LINES).optional().describe('max matching lines to print'),
        json: z.boolean().optional().describe('output as JSON'),
        recursive: z.boolean().optional().describe('descend into subdirectories (default: true)'),
        context: z.number().int().nonnegative().max(MCP_MAX_CONTEXT_LINES).optional().describe('lines of context to show before and after each match'),
        // runGrep takes no projectRoot of its own (its `path` array is its scope), so this field only names the root the confinement check is made against -- without it, a search rooted anywhere but the server process's cwd is refused.
        projectRoot: makeProjectRootField('search'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { pattern, path: searchPath, maxLines, json, recursive, context, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      // grep's `path` elements are whole files/directories, never `file::symbol` specs, so each is checked verbatim -- no comma splitting, since a comma can be a legitimate filename character. An omitted `path` still runs the gate (against the resolved root itself, which trivially passes): short-circuiting to `null` here used to skip confinement entirely, and runGrep then defaulted to `process.cwd()`, so omitting `path` searched the server process's own cwd unconfined. The same root is passed on as GrepOptions.projectRoot so the default search scope IS the gated root -- see the invariant on resolveToolRoot.
      const gate = confineTargets(searchPath === undefined ? [root] : searchPath, root, false)
      if (!gate.ok) return gate.refusal
      const confinedPath = searchPath === undefined ? undefined : [...gate.targets]
      return withConfinedRead(gate.pins, () =>
        toCallToolResultFromExitCode(() =>
          runGrep({
            pattern,
            ...(confinedPath !== undefined && confinedPath.length > 0 ? { path: confinedPath } : {}),
            ...(json === true ? { json: true } : {}),
            ...(maxLines !== undefined ? { maxLines } : {}),
            ...(recursive === false ? { recursive: false } : {}),
            ...(context !== undefined ? { context } : {}),
            projectRoot: root,
          }),
        ),
      )
    },
  )

  server.registerTool(
    'imports',
    {
      description: 'List the modules a file imports.',
      inputSchema: {
        file: z.string().describe('file path'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { file, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const gate = confineTargets([file], root)
      if (!gate.ok) return gate.refusal
      return withConfinedRead(gate.pins, () =>
        toCallToolResultFromExitCode(() =>
          runImports({ file: gate.targets[0]!, ...(json === true ? { json: true } : {}), projectRoot: root }),
        ),
      )
    },
  )

  server.registerTool(
    'exports',
    {
      description: 'List exported (public) symbols in a file.',
      inputSchema: {
        file: z.string().describe('file path'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const { file, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const gate = confineTargets([file], root)
      if (!gate.ok) return gate.refusal
      return withConfinedRead(gate.pins, () =>
        toCallToolResultFromExitCode(() =>
          runExports({ file: gate.targets[0]!, ...(json === true ? { json: true } : {}), projectRoot: root }),
        ),
      )
    },
  )

  server.registerTool(
    'compress_text',
    {
      description: 'Compress arbitrary local text, persist it in the bounded local cache, and return an opaque recovery ID plus metadata.',
      inputSchema: {
        text: z.string().max(CONTENT_MAX_INPUT_CHARS).describe('text to compress'),
      },
      // destructiveHint is true for every tool that writes here, including the ones that only ever add: the store is bounded by item count and by total bytes, so a write can evict an earlier entry and leave a recovery id the caller is holding unredeemable. idempotentHint survives a repeat writing a fresh timestamp and another stats row, on the same reading of "its environment" set out on the read tool above.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => toCallToolResult({ text: displaySafeJson(compressionPayload(compressText(args.text))), code: 0 }),
  )

  server.registerTool(
    'retrieve_text',
    {
      description: 'Retrieve original text from a token-goat compression ID.',
      inputSchema: {
        id: z.string().regex(/^tg_[0-9a-f]{16}$/).describe('opaque token-goat content ID'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const text = retrieveText(args.id)
      return text === null
        ? toCallToolResult({ text: `no token-goat content for id: ${args.id}`, code: 1 })
        : toRawCallToolResult({ text, code: 0 })
    },
  )

  server.registerTool(
    'handoff_create',
    {
      description: 'Create a bounded, project-local named compressed handoff for another agent.',
      inputSchema: {
        name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).describe('handoff name'),
        text: z.string().max(CONTENT_MAX_INPUT_CHARS).describe('handoff text'),
        projectRoot: makeProjectRootField('scope'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      toCallToolResult({
        text: displaySafeJson(createHandoff(args.name, args.text, resolveToolRoot(args.projectRoot))),
        code: 0,
      }),
  )

  server.registerTool(
    'handoff_resolve',
    {
      description: 'Resolve a project-local handoff compactly or in full. MCP does not intercept built-in file reads.',
      inputSchema: {
        name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).describe('handoff name'),
        full: z.boolean().optional().describe('return full text instead of a compact payload'),
        projectRoot: makeProjectRootField('scope'),
      },
      // Reads like a read, and is not one: resolving compactly runs the handoff text back through compressText, which stores the compact payload so the recovery id it hands back can be redeemed. A measurement, not a reading of this code -- the guard hashes the store's bytes around every tool call, and this is the tool it caught.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => {
      const result = resolveHandoff(args.name, {
        projectRoot: resolveToolRoot(args.projectRoot),
        ...(args.full === true ? { full: true } : {}),
      })
      return result === null
        ? toCallToolResult({ text: `no local handoff named "${args.name}" in this project`, code: 1 })
        : typeof result === 'string'
          ? toRawCallToolResult({ text: result, code: 0 })
          : toCallToolResult({ text: displaySafeJson(compressionPayload(result)), code: 0 })
    },
  )

  return server
}

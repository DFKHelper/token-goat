/** Whether the host's `Read(...)` deny rules cover a file a read is about to print, via assertReadAllowed */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CliError } from './command_error.js'
import { loadConfig } from './config.js'
import { emitErr } from './emit.js'
import { loadPermissionSnapshotOrThrow, ruleToolIs } from './rewrite_permission.js'
import type { PermissionRule, PermissionSnapshot } from './rewrite_permission.js'

/** Refusal to print a file the host denies with a `Read(...)` rule: a CliError (exit 1, one stderr line). */
export class ReadDeniedError extends CliError {
  override readonly prefix = '[tg] '
  override readonly jsonEnvelope = true
  /** True when the refusal is a failed check (unreadable or malformed settings), not a rule that matched. */
  readonly couldNotCheck: boolean
  constructor(message: string, couldNotCheck = false) {
    super(message)
    this.name = 'ReadDeniedError'
    this.couldNotCheck = couldNotCheck
  }
}

/** The pieces a check depends on, each injectable so a test needs neither real settings files nor real disk. */
export interface ReadDenyContext {
  readonly cwd?: string
  readonly projectDir?: string
  readonly home?: string
  readonly realpath?: (p: string) => string
  readonly loadSnapshot?: (cwd: string, projectDir: string | undefined) => PermissionSnapshot
  readonly now?: () => number
  /** Overrides `process.platform` for case folding and backslash handling, for a test. */
  readonly platform?: NodeJS.Platform
  /** Overrides `reads.honor_host_deny`, for a test. */
  readonly enabled?: boolean
}

/** One deny rule that covers a path, and the settings file it came from. */
export interface ReadDenyHit {
  readonly rule: string
  readonly source: string
}

interface CompiledRule {
  readonly raw: string
  readonly negated: boolean
  readonly matchAll: boolean
  readonly regexes: readonly RegExp[]
}

interface CompiledGroup {
  readonly source: string
  readonly rules: readonly CompiledRule[]
}

interface Compiled {
  readonly groups: readonly CompiledGroup[]
  /** Set when a settings source or a Read rule could not be understood: every read is then refused. */
  readonly failure: string | null
}

const MAX_ALTERNATIVES = 64
const CACHE_TTL_MS = 1000

/** Whether paths fold case on this platform: win32 and darwin only, a Linux path keeps its case. */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

function posixForMatch(p: string, platform: NodeJS.Platform): string {
  let s = platform === 'win32' ? p.replace(/\\/g, '/') : p
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(s)
  if (drive !== null) s = `/${drive[1] as string}${s.slice(2)}`
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return foldsCase(platform) ? s.toLowerCase() : s
}

function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern)
  if (m === null || !m[1]?.includes(',')) return [pattern]
  const out: string[] = []
  for (const alt of m[1].split(',')) {
    for (const rest of expandBraces(pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length))) {
      out.push(rest)
      if (out.length > MAX_ALTERNATIVES) throw new Error('too many brace alternatives')
    }
  }
  return out
}

function escapeRegex(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** An absolute lowercase posix glob as a whole-path regex; a backslash escapes when `escapes` is set. */
function globToRegex(glob: string, escapes: boolean): RegExp {
  let g = glob
  if (g.length > 1 && g.endsWith('/')) g = g.slice(0, -1)
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string
    if (c === '*') {
      if (g[i + 1] === '*') {
        const before = i === 0 || g[i - 1] === '/'
        let j = i + 2
        while (g[j] === '*') j++
        if (before && g[j] === '/') {
          re += '(?:.*/)?'
          i = j
        } else if (before && j >= g.length) {
          re += '.*'
          i = j - 1
        } else {
          re += '.*'
          i = j - 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '[') {
      const close = g.indexOf(']', i + 2)
      if (close < 0) {
        re += '\\['
      } else {
        let body = g.slice(i + 1, close)
        const neg = body.startsWith('!') || body.startsWith('^')
        if (neg) body = body.slice(1)
        re += `(?:(?!/)[${neg ? '^' : ''}${body.replace(/[\\^\]]/g, '\\$&')}])`
        i = close
      }
    } else if (c === '\\' && escapes && i + 1 < g.length) {
      re += escapeRegex(g[i + 1] as string)
      i++
    } else {
      re += escapeRegex(c)
    }
  }
  return new RegExp(`^${re}$`, 's')
}

function sourceRoots(source: string | undefined, cwd: string): string[] {
  if (source === undefined || source.startsWith('registry:')) return [cwd]
  const dir = path.dirname(source)
  return path.basename(dir).toLowerCase() === '.claude' ? [dir, path.dirname(dir)] : [dir, cwd]
}

/** The directory a relative rule is anchored to besides cwd: its project settings root, never the home dir. */
function projectRootOf(source: string | undefined, home: string, platform: NodeJS.Platform): string | null {
  if (source === undefined || source.startsWith('registry:')) return null
  const dir = path.dirname(source)
  const root = path.basename(dir).toLowerCase() === '.claude' ? path.dirname(dir) : dir
  return posixForMatch(root, platform) === posixForMatch(home, platform) ? null : root
}

/** The absolute posix globs a rule's content can mean; ambiguity adds a reading, any match denies. */
function anchoredGlobs(
  content: string,
  source: string | undefined,
  cwdBases: readonly string[],
  home: string,
  platform: NodeJS.Platform,
): string[] {
  const out: string[] = []
  const px = (p: string): string => posixForMatch(p, platform)
  const fold = (s: string): string => (foldsCase(platform) ? s.toLowerCase() : s)
  const projectRoot = projectRootOf(source, home, platform)
  const bases = projectRoot === null ? cwdBases : [...cwdBases, projectRoot]
  const variants = content.includes('\\') ? [content, content.replace(/\\/g, '/')] : [content]
  for (const v of variants) {
    const drive = /^([A-Za-z]):\//.exec(v)
    if (drive !== null) {
      out.push(px(`/${drive[1] as string}/${v.slice(3)}`))
    } else if (v.startsWith('//')) {
      out.push(px(v.slice(1)))
    } else if (v === '~' || v.startsWith('~/')) {
      out.push(`${px(home)}${fold(v.slice(1))}`)
    } else if (v.startsWith('/')) {
      for (const root of sourceRoots(source, cwdBases[0] as string)) {
        out.push(`${px(root)}${fold(v)}`)
      }
    } else if (v.startsWith('../')) {
      for (const base of bases) out.push(px(path.resolve(base, v)))
    } else {
      const rest = fold(v.startsWith('./') ? v.slice(2) : v)
      const anyDepth = rest.startsWith('**/') ? rest : '**/' + rest
      for (const base of bases) out.push(`${px(base)}/${anyDepth}`)
      for (const base of bases) out.push(`${px(base)}/${rest}`)
    }
  }
  return out
}

function compileRule(
  rule: PermissionRule,
  bases: readonly string[],
  home: string,
  platform: NodeJS.Platform,
): CompiledRule {
  const content = rule.content?.trim()
  if (content === undefined) return { raw: rule.raw, negated: false, matchAll: true, regexes: [] }
  if (content === '') throw new Error('empty Read rule')
  const negated = content.startsWith('!')
  const body = negated ? content.slice(1) : content
  if (body === '') throw new Error('empty Read rule after !')
  const regexes: RegExp[] = []
  const seen = new Set<string>()
  for (const glob of anchoredGlobs(body, rule.source, bases, home, platform)) {
    const literalAlso = expandBraces(glob)
    for (const g of [...literalAlso, glob]) {
      for (const escapes of [true, false]) {
        const re = globToRegex(g, escapes)
        if (!seen.has(re.source)) {
          seen.add(re.source)
          regexes.push(re)
        }
      }
    }
  }
  return { raw: rule.raw, negated, matchAll: false, regexes }
}

function compileSnapshot(
  snapshot: PermissionSnapshot,
  bases: readonly string[],
  home: string,
  platform: NodeJS.Platform,
): Compiled {
  const bySource = new Map<string, CompiledRule[]>()
  for (const rule of snapshot.deny) {
    const isRead = ruleToolIs(rule, ['read'])
    if (!isRead && !(rule.tool === undefined && /^\s*read\b/i.test(rule.raw))) continue
    const key = rule.source ?? 'a permission source'
    try {
      if (rule.tool === undefined) throw new Error('unparseable rule')
      const list = bySource.get(key) ?? []
      list.push(compileRule(rule, bases, home, platform))
      bySource.set(key, list)
    } catch (err) {
      const why = (err as Error).message
      return { groups: [], failure: `${key}: cannot parse the deny rule ${JSON.stringify(rule.raw)} (${why})` }
    }
  }
  return { groups: [...bySource].map(([source, rules]) => ({ source, rules })), failure: null }
}

function ruleMatches(rule: CompiledRule, posixPath: string): boolean {
  return rule.matchAll || rule.regexes.some((re) => re.test(posixPath))
}

/** The rule ignoring this path or a parent directory in one source: last match wins, a denied parent stays. */
function ignoredBy(rules: readonly CompiledRule[], posixPath: string): CompiledRule | null {
  const parts = posixPath.split('/')
  for (let i = 2; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    let last: CompiledRule | null = null
    for (const rule of rules) if (ruleMatches(rule, prefix)) last = rule
    if (last !== null && !last.negated) return last
  }
  return null
}

/** The first deny rule covering any of `candidates` (absolute paths), or null; throws on a bad rule. */
export function findReadDeny(
  snapshot: PermissionSnapshot,
  candidates: readonly string[],
  cwd: string,
  home: string = os.homedir(),
  extraBases: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): ReadDenyHit | null {
  const compiled = compileSnapshot(snapshot, [cwd, ...extraBases], home, platform)
  if (compiled.failure !== null) throw new Error(compiled.failure)
  return firstHit(compiled, candidates, platform)
}

function firstHit(
  compiled: Compiled,
  candidates: readonly string[],
  platform: NodeJS.Platform,
): ReadDenyHit | null {
  for (const candidate of candidates) {
    const posix = posixForMatch(candidate, platform)
    for (const group of compiled.groups) {
      const hit = ignoredBy(group.rules, posix)
      if (hit !== null) return { rule: hit.raw, source: group.source }
    }
  }
  return null
}

function realOf(p: string, realpath: (p: string) => string): string | null {
  let rest = ''
  let cur = p
  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = realpath(cur)
      return rest === '' ? real : path.join(real, rest)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return null
      rest = rest === '' ? path.basename(cur) : path.join(path.basename(cur), rest)
      cur = parent
    }
  }
  return null
}

let cache: { readonly key: string; readonly at: number; readonly compiled: Compiled } | undefined

/** Forget the loaded rules, for a test that changes the settings between checks. */
export function resetReadDenyCache(): void {
  cache = undefined
}

function load(
  cwd: string,
  projectDir: string | undefined,
  home: string,
  bases: readonly string[],
  ctx: ReadDenyContext,
  platform: NodeJS.Platform,
): Compiled {
  const now = (ctx.now ?? Date.now)()
  const key = JSON.stringify([cwd, projectDir, home, bases, platform, ctx.loadSnapshot === undefined])
  // limit: rules re-read once a second per process revisit-when: a deny edit must bite sooner
  const fresh = cache !== undefined && cache.key === key && now - cache.at < CACHE_TTL_MS
  if (ctx.loadSnapshot === undefined && fresh && cache !== undefined) return cache.compiled
  let compiled: Compiled
  try {
    const load =
      ctx.loadSnapshot ??
      ((c: string, p: string | undefined) =>
        loadPermissionSnapshotOrThrow(c, p, { outsideProject: 'project-only', sources: 'host-loaded' }))
    const snapshot = load(cwd, projectDir)
    compiled = compileSnapshot(snapshot, bases, home, platform)
  } catch (err) {
    compiled = { groups: [], failure: `could not read the host permission settings: ${(err as Error).message}` }
  }
  if (ctx.loadSnapshot === undefined) cache = { key, at: now, compiled }
  return compiled
}

/** Returns unless the host denies `target`, else throws ReadDeniedError; bad settings or rules refuse too. */
export function assertReadAllowed(target: string, ctx: ReadDenyContext = {}): void {
  const enabled = ctx.enabled ?? loadConfig().reads?.honor_host_deny !== false
  if (!enabled) return
  const cwd = path.resolve(ctx.cwd ?? process.cwd())
  const projectDir = ctx.projectDir ?? process.env['CLAUDE_PROJECT_DIR']
  const home = ctx.home ?? os.homedir()
  const realpath = ctx.realpath ?? ((p: string) => fs.realpathSync.native(p))
  const realCwd = realOf(cwd, realpath)
  const bases = realCwd === null || realCwd === cwd ? [cwd] : [cwd, realCwd]
  const platform = ctx.platform ?? process.platform
  const compiled = load(cwd, projectDir, home, bases, ctx, platform)
  if (compiled.failure !== null) {
    throw new ReadDeniedError(
      `read refused: ${target}: ${compiled.failure}; fix that setting or set reads.honor_host_deny to false`,
      true,
    )
  }
  if (compiled.groups.length === 0) return
  const abs = path.resolve(cwd, target)
  const real = realOf(abs, realpath)
  const hit = firstHit(compiled, real === null || real === abs ? [abs] : [abs, real], platform)
  if (hit !== null) {
    throw new ReadDeniedError(`read refused: ${target} is denied by ${hit.source}: ${hit.rule}`)
  }
}

/** The refusal line for `target`, or null when it may be shown; never throws, a failure counts as a refusal. */
export function readDenial(target: string, ctx: ReadDenyContext = {}): string | null {
  try {
    assertReadAllowed(target, ctx)
    return null
  } catch (err) {
    if (err instanceof ReadDeniedError) return err.message
    return `read refused: ${target}: the Read rules could not be checked`
  }
}

/** What an indexer may do with `target`: index it, drop its rows (denied), or skip it (unknown). */
export type IndexVerdict = 'allowed' | 'denied' | 'unknown'

/** Splits readDenial's refusal in two: a matched rule is `denied`, a check that could not run is `unknown`. */
export function indexVerdict(target: string, ctx: ReadDenyContext = {}): IndexVerdict {
  try {
    assertReadAllowed(target, ctx)
    return 'allowed'
  } catch (err) {
    if (err instanceof ReadDeniedError && !err.couldNotCheck) return 'denied'
    return 'unknown'
  }
}

/** The rows of files the host does not deny; each denied path is said once on stderr, never its text. */
export function dropDeniedRows<T>(rows: readonly T[], fileOf: (row: T) => string): T[] {
  const verdicts = new Map<string, boolean>()
  const kept: T[] = []
  for (const row of rows) {
    const file = fileOf(row)
    let ok = verdicts.get(file)
    if (ok === undefined) {
      const refusal = readDenial(file)
      ok = refusal === null
      verdicts.set(file, ok)
      if (refusal !== null) noteOmitted(refusal)
    }
    if (ok) kept.push(row)
  }
  return kept
}

/** Says on stderr, in one `[tg]` line, that a denied file's results were left out; names path and rule only. */
export function noteOmitted(refusal: string): void {
  emitErr(`[tg] omitted: ${refusal.replace(/^read refused: /, '')}`)
}

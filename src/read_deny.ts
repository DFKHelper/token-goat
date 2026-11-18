/** Whether the host's `Read(...)` deny rules cover a file a token-goat read is about to print, and the one chokepoint, assertReadAllowed, every read command calls to refuse it */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CliError } from './command_error.js'
import { loadConfig } from './config.js'
import { loadPermissionSnapshotOrThrow, ruleToolIs } from './rewrite_permission.js'
import type { PermissionRule, PermissionSnapshot } from './rewrite_permission.js'

/** Refusal to print a file the host denies with a `Read(...)` rule: a CliError, so exit 1 plus a stderr line. */
export class ReadDeniedError extends CliError {
  override readonly prefix = '[tg] '
  override readonly jsonEnvelope = true
  constructor(message: string) {
    super(message)
    this.name = 'ReadDeniedError'
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

function posixForMatch(p: string): string {
  let s = process.platform === 'win32' ? p.replace(/\\/g, '/') : p
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(s)
  if (drive !== null) s = `/${drive[1] as string}${s.slice(2)}`
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s.toLowerCase()
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

/** An absolute lowercase posix glob as a regex matching a whole path; a backslash escapes when `escapes` is set. */
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

/** The absolute posix globs a rule's content can mean; ambiguity adds a reading, and any reading matching denies. */
function anchoredGlobs(
  content: string,
  source: string | undefined,
  bases: readonly string[],
  home: string,
): string[] {
  const out: string[] = []
  const variants = content.includes('\\') ? [content, content.replace(/\\/g, '/')] : [content]
  for (const v of variants) {
    const drive = /^([A-Za-z]):\//.exec(v)
    if (drive !== null) {
      out.push(posixForMatch(`/${drive[1] as string}/${v.slice(3)}`))
    } else if (v.startsWith('//')) {
      out.push(posixForMatch(v.slice(1)))
    } else if (v === '~' || v.startsWith('~/')) {
      out.push(`${posixForMatch(home)}${v.slice(1).toLowerCase()}`)
    } else if (v.startsWith('/')) {
      for (const root of sourceRoots(source, bases[0] as string)) {
        out.push(`${posixForMatch(root)}${v.toLowerCase()}`)
      }
    } else if (v.startsWith('../')) {
      for (const base of bases) out.push(posixForMatch(path.resolve(base, v)))
    } else {
      const rest = (v.startsWith('./') ? v.slice(2) : v).toLowerCase()
      const anyDepth = rest.startsWith('**/') ? rest : '**/' + rest
      for (const base of bases) out.push(`${posixForMatch(base)}/${anyDepth}`)
      for (const base of bases) out.push(`${posixForMatch(base)}/${rest}`)
    }
  }
  return out
}

function compileRule(rule: PermissionRule, bases: readonly string[], home: string): CompiledRule {
  const content = rule.content?.trim()
  if (content === undefined) return { raw: rule.raw, negated: false, matchAll: true, regexes: [] }
  if (content === '') throw new Error('empty Read rule')
  const negated = content.startsWith('!')
  const body = negated ? content.slice(1) : content
  if (body === '') throw new Error('empty Read rule after !')
  const regexes: RegExp[] = []
  const seen = new Set<string>()
  for (const glob of anchoredGlobs(body, rule.source, bases, home)) {
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

function compileSnapshot(snapshot: PermissionSnapshot, bases: readonly string[], home: string): Compiled {
  const bySource = new Map<string, CompiledRule[]>()
  for (const rule of snapshot.deny) {
    const isRead = ruleToolIs(rule, ['read'])
    if (!isRead && !(rule.tool === undefined && /^\s*read\b/i.test(rule.raw))) continue
    const key = rule.source ?? 'a permission source'
    try {
      if (rule.tool === undefined) throw new Error('unparseable rule')
      const list = bySource.get(key) ?? []
      list.push(compileRule(rule, bases, home))
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

/** The rule ignoring this path or a parent directory within one source: last match wins, an ignored parent stays. */
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

/** The first deny rule covering any of `candidates` (absolute paths), or null; throws on an unparseable rule. */
export function findReadDeny(
  snapshot: PermissionSnapshot,
  candidates: readonly string[],
  cwd: string,
  home: string = os.homedir(),
  extraBases: readonly string[] = [],
): ReadDenyHit | null {
  const compiled = compileSnapshot(snapshot, [cwd, ...extraBases], home)
  if (compiled.failure !== null) throw new Error(compiled.failure)
  return firstHit(compiled, candidates)
}

function firstHit(compiled: Compiled, candidates: readonly string[]): ReadDenyHit | null {
  for (const candidate of candidates) {
    const posix = posixForMatch(candidate)
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
): Compiled {
  const now = (ctx.now ?? Date.now)()
  const key = JSON.stringify([cwd, projectDir, home, bases, ctx.loadSnapshot === undefined])
  // limit: rules are re-read at most once a second per process revisit-when: a deny edit must bite within a second
  const fresh = cache !== undefined && cache.key === key && now - cache.at < CACHE_TTL_MS
  if (ctx.loadSnapshot === undefined && fresh && cache !== undefined) return cache.compiled
  let compiled: Compiled
  try {
    const snapshot = (ctx.loadSnapshot ?? loadPermissionSnapshotOrThrow)(cwd, projectDir)
    compiled = compileSnapshot(snapshot, bases, home)
  } catch (err) {
    compiled = { groups: [], failure: `could not read the host permission settings: ${(err as Error).message}` }
  }
  if (ctx.loadSnapshot === undefined) cache = { key, at: now, compiled }
  return compiled
}

/** Returns when the host's settings do not deny reading `target`, else throws ReadDeniedError naming file and rule; fails closed on an unreadable settings file or unparseable Read rule. */
export function assertReadAllowed(target: string, ctx: ReadDenyContext = {}): void {
  const enabled = ctx.enabled ?? loadConfig().reads?.honor_host_deny !== false
  if (!enabled) return
  const cwd = path.resolve(ctx.cwd ?? process.cwd())
  const projectDir = ctx.projectDir ?? process.env['CLAUDE_PROJECT_DIR']
  const home = ctx.home ?? os.homedir()
  const realpath = ctx.realpath ?? ((p: string) => fs.realpathSync.native(p))
  const realCwd = realOf(cwd, realpath)
  const bases = realCwd === null || realCwd === cwd ? [cwd] : [cwd, realCwd]
  const compiled = load(cwd, projectDir, home, bases, ctx)
  if (compiled.failure !== null) {
    throw new ReadDeniedError(
      `read refused: ${target}: ${compiled.failure}; fix that setting or set reads.honor_host_deny to false`,
    )
  }
  if (compiled.groups.length === 0) return
  const abs = path.resolve(cwd, target)
  const real = realOf(abs, realpath)
  const hit = firstHit(compiled, real === null || real === abs ? [abs] : [abs, real])
  if (hit !== null) {
    throw new ReadDeniedError(`read refused: ${target} is denied by ${hit.source}: ${hit.rule}`)
  }
}

/** Codex's half of rewrite_permission.ts: Codex matches its execpolicy rules (https://developers.openai.com/codex/rules) against a command's words, which `token-goat compress` moves behind the wrapper, so a Codex shell rewrite ships only when no rule could match the original. Loaded by rewrite_permission.ts's loadCodexRules only for a Codex Bash call, so this parser stays off every other hook's eager path. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as RewritePermission from './rewrite_permission.js'
import type { RewriteRequest, RewriteVerdict } from './rewrite_permission.js'

/** The rewrite_permission.ts helpers this check shares, which loadCodexRules passes in rather than this module importing them: a static import from this lazily loaded module would split rewrite_permission.ts out of the hook's eager chunk into chunks of its own. */
export type CodexRuleHelpers = Pick<typeof RewritePermission, 'containsPiece' | 'haystacks' | 'readIfExists' | 'selfAndAncestors' | 'sourceAllowed'>

// Shells Codex hands a script it cannot split to whole, as `[shell, "-lc", script]`, so a rule naming one can match a command that holds no such word (https://developers.openai.com/codex/rules, "When Codex does not split the script").
const CODEX_SHELL = /^(?:.*[/\\])?(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd)(?:\.exe)?$/i
const STARLARK_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', '\\': '\\', '"': '"', "'": "'" }
type StarlarkValue = string | null | StarlarkValue[]

/** The tokens of a Codex `.rules` file: a string as `"` and its value, a name or punctuation mark as itself. Throws on what this Starlark subset does not read (triple-quoted or prefixed strings, other escapes), so such a file fails closed. */
function starlarkTokens(text: string): string[] {
  const out: string[] = []
  const word = /[A-Za-z_]\w*|[()[\],=]/y
  for (let i = 0; i < text.length; ) {
    const ch = text[i] as string
    if (/\s/.test(ch)) i++
    else if (ch === '#') i = text.includes('\n', i) ? text.indexOf('\n', i) : text.length
    else if (ch === '"' || ch === "'") {
      let value = '"'
      for (i++; text[i] !== ch; i++) {
        const c = text[i]
        if (c === undefined || c === '\n') throw new Error('unterminated string')
        const escaped = c === '\\' ? STARLARK_ESCAPES[text[++i] ?? ''] : c
        if (escaped === undefined) throw new Error('unsupported escape')
        value += escaped
      }
      i++
      out.push(value)
    } else {
      word.lastIndex = i
      const m = word.exec(text)
      if (m === null) throw new Error(`unexpected ${ch}`)
      out.push(m[0])
      i = word.lastIndex
    }
  }
  return out
}

/** The prefix patterns of a Codex `.rules` file, each the alternatives at every position, from the builtins of https://github.com/openai/codex/blob/main/codex-rs/execpolicy/src/parser.rs: top-level `prefix_rule`, `network_rule` and `host_executable` calls with string, list and True/False/None arguments. Throws on anything else. */
function codexPrefixPatterns(text: string): string[][][] {
  const toks = starlarkTokens(text)
  let at = 0
  const take = (want?: string): string => {
    const t = toks[at++]
    if (t === undefined || (want !== undefined && t !== want)) throw new Error(`expected ${want ?? 'more'}`)
    return t
  }
  const value = (): StarlarkValue => {
    const t = take()
    if (t.startsWith('"')) return t.slice(1)
    if (t === 'True' || t === 'False' || t === 'None') return null
    if (t !== '[') throw new Error(`unexpected ${t}`)
    const items: StarlarkValue[] = []
    while (toks[at] !== ']') {
      items.push(value())
      if (toks[at] !== ']') take(',')
    }
    at++
    return items
  }
  const patterns: string[][][] = []
  while (at < toks.length) {
    const fn = take()
    if (fn !== 'prefix_rule' && fn !== 'network_rule' && fn !== 'host_executable') throw new Error(`unsupported statement ${fn}`)
    take('(')
    const args = new Map<string, StarlarkValue>()
    while (toks[at] !== ')') {
      const named = toks[at + 1] === '=' && /^[A-Za-z_]/.test(toks[at] ?? '')
      const key = named ? take() : `#${String(args.size)}`
      if (named) take('=')
      args.set(key, value())
      if (toks[at] !== ')') take(',')
    }
    at++
    if (fn !== 'prefix_rule') continue
    const pattern = args.get('pattern') ?? args.get('#0')
    // An empty pattern, which Codex refuses to load, matches every command in decideCodex, so it fails closed like any other unreadable rule.
    if (!Array.isArray(pattern)) throw new Error('prefix_rule without a pattern')
    patterns.push(pattern.map((el) => {
      const alts = typeof el === 'string' ? [el] : el
      if (!Array.isArray(alts) || alts.length === 0 || !alts.every((a) => typeof a === 'string')) throw new Error('unreadable pattern element')
      return alts as string[]
    }))
  }
  return patterns
}

/** The prefix patterns of every Codex rules file that could apply to a command run in `cwd` (https://developers.openai.com/codex/rules: `rules/*.rules` beside each config layer, the system's, the user's and a trusted project's `.codex`), read whether or not Codex trusts the project. Null when one cannot be read or parsed, or an admin requirements source could add rules: a requirements.toml naming `prefix_rules`, or a macOS managed preference (https://developers.openai.com/codex/enterprise/managed-configuration). */
function loadCodexRulePatterns(cwd: string, { readIfExists, selfAndAncestors, sourceAllowed }: CodexRuleHelpers): string[][][] | null {
  try {
    const system = process.platform === 'win32' ? path.join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'OpenAI', 'Codex') : '/etc/codex'
    if (/prefix_rules/.test(readIfExists(path.join(system, 'requirements.toml')) ?? '')) return null
    if (process.platform === 'darwin' && ['/Library/Managed Preferences/com.openai.codex.plist', path.join('/Library/Managed Preferences', os.userInfo().username, 'com.openai.codex.plist')].some((p) => sourceAllowed(p) && fs.existsSync(p))) return null
    const codexHome = process.env['CODEX_HOME']
    const layers = [system, path.join(os.homedir(), '.codex'), ...(codexHome !== undefined && codexHome !== '' ? [path.resolve(codexHome)] : []), ...selfAndAncestors(path.resolve(cwd)).map((d) => path.join(d, '.codex'))]
    const seen = new Set<string>()
    const patterns: string[][][] = []
    for (const layer of layers) {
      const dir = path.join(layer, 'rules')
      const key = process.platform === 'win32' ? dir.toLowerCase() : dir
      if (seen.has(key)) continue
      seen.add(key)
      for (const name of readIfExists(dir, true) ?? []) {
        if (name.endsWith('.rules')) patterns.push(...codexPrefixPatterns(fs.readFileSync(path.join(dir, name), 'utf8')))
      }
    }
    return patterns
  } catch {
    return null
  }
}

/** The verdict for a Codex shell rewrite: it ships only when no rule of any decision could match the original, since a forbidden or prompt rule would stop applying to it, and an allow rule, which runs the command outside the sandbox, would stop doing so. */
export function decideCodex(req: RewriteRequest, helpers: CodexRuleHelpers): RewriteVerdict {
  const { containsPiece, haystacks } = helpers
  const patterns = loadCodexRulePatterns(req.cwd, helpers)
  if (patterns === null) return 'skip'
  const hays = haystacks([req.original])
  // Each token is folded the way its haystack was, and an empty one matches anything (containsPiece would never return on it).
  const has = (h: string, i: number, t: string): boolean => {
    const text = haystacks([t])[i] as string
    return text === '' || containsPiece(h, { text, openLeft: false, openRight: false })
  }
  // A rule naming a shell can match the call Codex makes for a script it cannot split, `[shell, flag, script]`, whose shell and flags the hook never sees, so only its other tokens (the script, as a saved approval spells it) must appear.
  const mayMatch = (pattern: string[][]): boolean => {
    const rest = pattern[0]?.some((t) => CODEX_SHELL.test(t)) === true ? pattern.slice(1).filter((alts) => !alts.every((t) => t.startsWith('-'))) : pattern
    return hays.some((h, i) => rest.every((alts) => alts.some((t) => has(h, i, t))))
  }
  return patterns.some(mayMatch) ? 'skip' : 'rewrite'
}

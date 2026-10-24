// Config for the architecture map: discovery roots, layers and excludes, read from `.arch-doc-sync.json` or `config/arch-docs.json`. Contract: SKILL.md "Config" of the arch-doc-sync skill; the reference engine is sync_arch_docs.py, section "config.mts".
import { CODE_SUFFIXES } from './exports.mjs'

export const UNCATEGORIZED = 'Uncategorized'
export const CONFIG_CANDIDATES = ['.arch-doc-sync.json', 'config/arch-docs.json']
const DOC_CANDIDATES = ['CLAUDE.arch.md', 'ARCHITECTURE.md', 'docs/architecture.md']
const FALLBACK_DOC = 'ARCHITECTURE.md'
const DEFAULT_ROOTS = ['src', 'lib', 'pkg', 'app', 'internal']
const DEFAULT_EXCLUDES = [
  'tests/*', '*/tests/*', '*_test.*', '*.spec.*', '*/fixtures/*', '*/migrations/*', 'dist/*', 'build/*',
  '*.min.js', '*.bundle.js', '*_pb2.py', '*.g.dart', 'vendor/*', '*/vendor/*', 'third_party/*',
  '*/third_party/*', '__init__.py', '*/__init__.py', 'index.ts', '*/index.ts',
]
const CONFIG_KEYS = new Set(['doc', 'roots', 'layers', 'exclude', 'useDefaultExcludes'])
const FORBIDDEN_NAME_CHARS = /[|`\r\n]|<!--|--!?>/
const DOC_SUFFIX = /\.(?:md|markdown|mdx|txt)$/i
const RESERVED_PATH_CHAR = /[<>:"|?*]/
const hasControlChar = (text) => Array.from(text).some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
const DOS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[0-9]|conin\$|conout\$)$/i

/** An error that must exit 2: a configuration or usage problem, never drift. */
export class ArchDocError extends Error {}

/** True for a non-empty, forward-slash, repo-relative path with no `.`, `..` or empty segment. */
export function isRepoRelative(p) {
  if (p === '' || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false
  return p.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function validateDocPath(doc, where) {
  if (doc.includes('\\')) throw new ArchDocError(`${where}: must use forward slashes, not backslashes`)
  if (!isRepoRelative(doc)) throw new ArchDocError(`${where}: must be a repo-relative path with no ".", ".." or trailing "/"`)
  for (const segment of doc.split('/')) {
    if (/^\.git(?:~[0-9]+)?$/i.test(segment.replace(/[. ]+$/, ''))) throw new ArchDocError(`${where}: must not be inside .git`)
    if (RESERVED_PATH_CHAR.test(segment) || hasControlChar(segment)) throw new ArchDocError(`${where}: must not contain a Windows-reserved or control character`)
    if (/[. ]$/.test(segment)) throw new ArchDocError(`${where}: no segment may end in a dot or space`)
    if (DOS_DEVICE.test(segment.replace(/\..*$/s, '').replace(/ +$/, ''))) throw new ArchDocError(`${where}: must not name a DOS device`)
  }
  if (!DOC_SUFFIX.test(doc)) throw new ArchDocError(`${where}: must end in .md, .markdown, .mdx or .txt`)
}

function parseRoot(entry, where) {
  if (typeof entry === 'string') {
    if (!isRepoRelative(entry)) throw new ArchDocError(`${where}: must be a repo-relative path with no ".", ".." or trailing "/"`)
    return entry
  }
  throw new ArchDocError(`${where}: must be a path string; {path, unit, depth} roots are not supported by this engine`)
}

function parseLayer(pair, where) {
  if (!Array.isArray(pair) || pair.length !== 2) throw new ArchDocError(`${where}: must be a [prefix, name] pair`)
  const [rawPrefix, name] = pair
  if (typeof rawPrefix !== 'string') throw new ArchDocError(`${where}: prefix must be a string`)
  const prefix = rawPrefix.replace(/\/+$/, '')
  if ((rawPrefix !== '' && prefix === '') || (prefix !== '' && !isRepoRelative(prefix))) {
    throw new ArchDocError(`${where}: prefix must be repo-relative`)
  }
  if (typeof name !== 'string' || name === '' || name !== name.trim() || FORBIDDEN_NAME_CHARS.test(name)) {
    throw new ArchDocError(`${where}: name must be non-empty, unpadded, and free of |, backticks, newlines, and HTML comment markers`)
  }
  return { prefix, name }
}

const covers = (outer, inner) => outer === '' || inner === outer || inner.startsWith(`${outer}/`)

function assertReachableLayers(layers, source) {
  layers.forEach((layer, i) => {
    const earlier = layers.findIndex((other, k) => k < i && covers(other.prefix, layer.prefix))
    if (earlier === -1) return
    const where = `${source}: layers[${i}]`
    if (layers[earlier].prefix === layer.prefix) throw new ArchDocError(`${where}: duplicate prefix "${layer.prefix}" (also layers[${earlier}])`)
    throw new ArchDocError(`${where}: prefix "${layer.prefix}" can never match, layers[${earlier}] prefix "${layers[earlier].prefix}" claims it first`)
  })
}

function parseStringList(value, where) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) {
    throw new ArchDocError(`${where}: must be an array of non-empty strings`)
  }
  return value
}

function parseConfig(raw, source, defaultDoc) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ArchDocError(`${source}: config must be a JSON object`)
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) throw new ArchDocError(`${source}: unknown key "${key}"`)
  }
  let doc = defaultDoc
  if ('doc' in raw) {
    if (typeof raw.doc !== 'string') throw new ArchDocError(`${source}: doc must be a repo-relative path inside the repository`)
    validateDocPath(raw.doc, `${source}: doc`)
    doc = raw.doc
  }
  let roots = DEFAULT_ROOTS
  if ('roots' in raw) {
    if (!Array.isArray(raw.roots)) throw new ArchDocError(`${source}: roots must be an array`)
    roots = raw.roots.map((entry, i) => parseRoot(entry, `${source}: roots[${i}]`))
    const seen = new Set()
    for (const root of roots) {
      if (seen.has(root)) throw new ArchDocError(`${source}: duplicate root "${root}"`)
      seen.add(root)
    }
  }
  let layers = [{ prefix: '', name: UNCATEGORIZED }]
  if ('layers' in raw) {
    if (!Array.isArray(raw.layers)) throw new ArchDocError(`${source}: layers must be an array of [prefix, name] pairs`)
    layers = raw.layers.map((pair, i) => parseLayer(pair, `${source}: layers[${i}]`))
    assertReachableLayers(layers, source)
  }
  const user = 'exclude' in raw ? parseStringList(raw.exclude, `${source}: exclude`) : []
  const useDefaults = 'useDefaultExcludes' in raw ? raw.useDefaultExcludes : true
  if (typeof useDefaults !== 'boolean') throw new ArchDocError(`${source}: useDefaultExcludes must be a boolean`)
  return { doc, roots, layers, exclude: useDefaults ? [...user, ...DEFAULT_EXCLUDES] : user }
}

/** Loads the config through `reader` (`has(path)`, `read(path)` -> text): the one candidate present, or the defaults. Both candidates present is ambiguous and exits 2. */
export function loadConfig(reader) {
  const found = CONFIG_CANDIDATES.filter((candidate) => reader.has(candidate))
  if (found.length > 1) throw new ArchDocError(`ambiguous config: both ${found[0]} and ${found[1]} exist, keep one`)
  const defaultDoc = DOC_CANDIDATES.find((candidate) => reader.has(candidate)) ?? FALLBACK_DOC
  if (found.length === 0) return parseConfig({}, 'config', defaultDoc)
  const source = found[0]
  let raw
  try {
    raw = JSON.parse(reader.read(source).replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new ArchDocError(`could not read config ${source}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseConfig(raw, source, defaultDoc)
}

/** The first layer whose prefix contains `key`, on a path-segment boundary; a module no prefix claims is Uncategorized. */
export function layerFor(key, layers) {
  return layers.find((layer) => covers(layer.prefix, key))?.name ?? UNCATEGORIZED
}

/** Layer names in declared order, with Uncategorized last when the config does not name it. */
export function layerOrder(layers) {
  const names = [...new Set(layers.map((layer) => layer.name))]
  return names.includes(UNCATEGORIZED) ? names : [...names, UNCATEGORIZED]
}

/** Case-sensitive fnmatch: `*` crosses `/`, `?` is one character, `[seq]` and `[!seq]` are classes, an unclosed `[` is literal. */
export function globMatch(pattern, candidate) {
  let compiled = GLOB_CACHE.get(pattern)
  if (compiled === undefined) {
    compiled = compileGlob(pattern)
    GLOB_CACHE.set(pattern, compiled)
  }
  return compiled.test(candidate)
}

const GLOB_CACHE = new Map()

function compileGlob(pattern) {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      source += '[\\s\\S]*'
    } else if (ch === '?') {
      source += '[\\s\\S]'
    } else if (ch === '[') {
      let j = i + 1
      const negated = pattern[j] === '!'
      if (negated) j++
      const bodyStart = j
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j++
      if (j >= pattern.length) {
        source += '\\['
      } else {
        const body = pattern.slice(bodyStart, j).replace(/[\\\]^]/g, '\\$&')
        source += `[${negated ? '^' : ''}${body}]`
        i = j
      }
    } else {
      source += ch.replace(/[.+^${}()|\\\]]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`${source}$`, 'u')
  } catch {
    throw new ArchDocError(`exclude pattern ${JSON.stringify(pattern)} is not a valid glob (a character class range is out of order)`)
  }
}

/** True when `file` ends in a suffix this engine can read exports and doc comments from. */
export const isCodeFile = (file) => CODE_SUFFIXES.some((suffix) => file.endsWith(suffix))

/** The configured root that claims `file`: the longest root path containing it, or undefined. */
export function selectRoot(roots, file) {
  let best
  for (const root of roots) {
    if ((file === root || file.startsWith(`${root}/`)) && (best === undefined || root.length > best.length)) best = root
  }
  return best
}

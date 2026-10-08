/** Checks that a `package-lock.json` agrees with itself: every dependency spec an entry declares is satisfied by the entry node would resolve for it. A lock that fails this is not a lock `npm install` leaves alone. Commit b479903b left `packages["node_modules/lefthook"].optionalDependencies` at 2.1.14 while the platform packages beside it were 2.1.15, so every install nested a second 2.1.14 copy under lefthook and rewrote the file, and nothing flagged the commit. Shared by `tests/guards/lock_file_is_self_consistent.test.ts` and `scripts/refresh-dependabot-lock.mjs`, so one definition of "consistent" decides both. The semver subset is what the real lock uses and no more (`semver` is only a transitive dependency here, and adding one for this would put a new package in the tree the lock describes): exact versions, `=`, `^`, `~`, comparators, partial and `x`/`*` ranges, and `||`. A spec outside it is reported as unverifiable rather than skipped, so a lock that starts needing more fails loudly and this module gets extended. */

import * as fs from 'node:fs'
import * as path from 'node:path'

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const COMPARATOR = /(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?/y
const FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

function parseVersion(text) {
  const match = VERSION.exec(text ?? '')
  if (!match) return null
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const aNum = /^\d+$/.test(a[i])
    const bNum = /^\d+$/.test(b[i])
    if (aNum && bNum) {
      const diff = Number(a[i]) - Number(b[i])
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1
    }
  }
  return 0
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] < b.numbers[i] ? -1 : 1
  }
  return comparePre(a.pre, b.pre)
}

const isWildcard = (part) => part === undefined || part === 'x' || part === 'X' || part === '*'
const floor = (numbers, pre = []) => ({ numbers, pre })

/** One comparator token to `[operator, version]` pairs, all of which must hold. */
function expand(op, rawParts, pre) {
  const parts = rawParts.map((part) => (isWildcard(part) ? null : Number(part)))
  if (parts[0] === null) return []
  const [major, minor, patch] = parts
  const preList = pre ? pre.split('.') : []
  const lower = (numbers, withPre) => ['>=', floor(numbers, withPre)]
  const upper = (numbers) => ['<', floor(numbers)]
  if (op === '' || op === '=') {
    if (minor === null) return [lower([major, 0, 0]), upper([major + 1, 0, 0])]
    if (patch === null) return [lower([major, minor, 0]), upper([major, minor + 1, 0])]
    return [['=', floor([major, minor, patch], preList)]]
  }
  if (op === '^') {
    const base = [major, minor ?? 0, patch ?? 0]
    let ceiling
    if (major > 0 || minor === null) ceiling = [major + 1, 0, 0]
    else if (minor > 0 || patch === null) ceiling = [0, minor + 1, 0]
    else ceiling = [0, 0, patch + 1]
    return [lower(base, preList), upper(ceiling)]
  }
  if (op === '~') {
    const ceiling = minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0]
    return [lower([major, minor ?? 0, patch ?? 0], preList), upper(ceiling)]
  }
  if (op === '>=') return [lower([major, minor ?? 0, patch ?? 0], preList)]
  if (op === '>') {
    if (minor === null) return [['>=', floor([major + 1, 0, 0])]]
    if (patch === null) return [['>=', floor([major, minor + 1, 0])]]
    return [['>', floor([major, minor, patch], preList)]]
  }
  if (op === '<') return [['<', floor([major, minor ?? 0, patch ?? 0], preList)]]
  if (minor === null) return [upper([major + 1, 0, 0])]
  if (patch === null) return [upper([major, minor + 1, 0])]
  return [['<=', floor([major, minor, patch], preList)]]
}

/** Parses a range into alternatives, each a list of comparators; null when the spec uses syntax outside the supported subset. */
export function parseRange(spec) {
  if (typeof spec !== 'string') return null
  const alternatives = []
  for (const piece of spec.split('||')) {
    const text = piece.trim()
    const comparators = []
    COMPARATOR.lastIndex = 0
    let position = 0
    while (position < text.length) {
      while (text[position] === ' ') position += 1
      if (position >= text.length) break
      COMPARATOR.lastIndex = position
      const match = COMPARATOR.exec(text)
      if (!match || match[0].length === 0) return null
      comparators.push(...expand(match[1] ?? '', [match[2], match[3], match[4]], match[5]))
      position = COMPARATOR.lastIndex
    }
    alternatives.push(comparators)
  }
  return alternatives
}

function holds(version, [op, bound]) {
  const order = compareVersions(version, bound)
  if (op === '=') return order === 0
  if (op === '>=') return order >= 0
  if (op === '>') return order > 0
  if (op === '<') return order < 0
  return order <= 0
}

/** A prerelease only satisfies a range that names a prerelease of the same major.minor.patch, which is semver's rule and npm's. */
function satisfiesAlternative(version, comparators) {
  if (!comparators.every((comparator) => holds(version, comparator))) return false
  if (version.pre.length === 0) return true
  return comparators.some(([, bound]) => bound.pre.length > 0 && bound.numbers.every((value, i) => value === version.numbers[i]))
}

/** True, false, or null when the spec or the version is outside the supported subset. */
export function satisfies(versionText, spec) {
  const version = parseVersion(versionText)
  const alternatives = parseRange(spec)
  if (!version || !alternatives) return null
  return alternatives.some((comparators) => satisfiesAlternative(version, comparators))
}

/** The entry node loads for `name` from `from`: the nearest node_modules walking up from the dependent's own path. */
export function resolveEntry(packages, from, name) {
  let base = from
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`
    if (packages[candidate]) return { path: candidate, entry: packages[candidate] }
    if (!base) return null
    const cut = base.lastIndexOf('node_modules/')
    base = cut <= 0 ? '' : base.slice(0, cut - 1)
  }
}

/** The spec `overrides` forces for a dependency, or undefined. A `$name` value means "whatever the root package declares for name". Only top-level string overrides and the names inside nested override objects are read, and a nested one is applied to every dependent, which is looser than npm; this repository's `package.json` uses only top-level strings. */
function overrideFor(name, overrides, rootEntry) {
  const value = overrides?.[name]
  if (typeof value === 'string') {
    if (!value.startsWith('$')) return value
    const key = value.slice(1)
    return rootEntry?.dependencies?.[key] ?? rootEntry?.devDependencies?.[key] ?? rootEntry?.optionalDependencies?.[key]
  }
  if (value && typeof value === 'object' && typeof value['.'] === 'string') return value['.']
  return undefined
}

/** Returns every inconsistency in the lock as `{ dependent, field, name, spec, kind, resolvedPath, resolvedVersion }`. `kind` is `mismatch`, `missing` (a required dependency resolves to nothing), or `unsupported` (the spec cannot be checked). A missing optional dependency is legal, and so is a missing peer: this repository installs with `legacy-peer-deps`, so the lock does not carry them. */
export function checkLockConsistency(lock, { overrides } = {}) {
  const packages = lock?.packages ?? {}
  const problems = []
  for (const [dependent, entry] of Object.entries(packages)) {
    if (entry.link) continue
    const fields = dependent === '' ? [...FIELDS, 'devDependencies'] : FIELDS
    for (const field of fields) {
      for (const [name, spec] of Object.entries(entry[field] ?? {})) {
        const resolved = resolveEntry(packages, dependent, name)
        const base = { dependent, field, name, spec }
        if (!resolved || resolved.entry.link || typeof resolved.entry.version !== 'string') {
          if (!resolved && (field === 'dependencies' || field === 'devDependencies')) problems.push({ ...base, kind: 'missing' })
          continue
        }
        if (field === 'peerDependencies' && entry.peerDependenciesMeta?.[name]?.optional === true) continue
        const forced = overrideFor(name, overrides, packages[''])
        const verdict = satisfies(resolved.entry.version, forced ?? spec)
        if (verdict === true) continue
        problems.push({ ...base, ...(forced === undefined ? {} : { spec: forced, declaredSpec: spec }), kind: verdict === null ? 'unsupported' : 'mismatch', resolvedPath: resolved.path, resolvedVersion: resolved.entry.version })
      }
    }
  }
  return problems
}

/** Reads package-lock.json and the `overrides` of package.json under `root` and checks them together. */
export function checkLockFiles(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  return checkLockConsistency(lock, { overrides: manifest.overrides })
}

export function formatProblem(problem) {
  const who = problem.dependent === '' ? 'the root package' : problem.dependent
  const forced = problem.declaredSpec === undefined ? '' : ` (forced by overrides, replacing ${problem.declaredSpec})`
  const declared = `${who} declares ${problem.field} ${problem.name}@${problem.spec}${forced}`
  if (problem.kind === 'missing') return `${declared}, but nothing in the lock resolves it`
  if (problem.kind === 'unsupported') return `${declared}, which uses range syntax scripts/lock-consistency.mjs cannot check (it resolves to ${problem.resolvedPath}@${problem.resolvedVersion}); extend the module`
  return `${declared}, but node resolves ${problem.resolvedPath}@${problem.resolvedVersion}, which does not satisfy it`
}

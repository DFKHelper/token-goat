/** Reads the change a commit makes to package-lock.json the way a reviewer needs it read, and judges it. `diffLocks` is the structural diff (packages added, removed, moved to another version, reclassified between optional, dev and peer, newly carrying an install script); `auditLockChange` adds the checks that a green suite cannot make: every package that arrived or moved must have been published before the cooldown window in `.github/dependabot.yml` closed, its integrity must be the one the registry serves for that exact version, and the resulting lock must agree with itself (`scripts/lock-consistency.mjs`). The registry is injected as `lookup(name, version) -> { publishedAt, integrity }`, so tests run with no network; `scripts/refresh-dependabot-lock.mjs --audit-commit` supplies `npm view`. A package the lookup cannot answer for is a violation, never a pass. */
import { checkLockConsistency, formatProblem } from './lock-consistency.mjs'

const FLAGS = ['optional', 'dev', 'peer', 'devOptional']
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']
const DAY_MS = 24 * 60 * 60 * 1000

/** The registry name a lock path installs: the segment after the last node_modules/, or the `name` an aliased entry records. */
export function packageName(lockPath, entry) {
  if (typeof entry?.name === 'string') return entry.name
  const cut = lockPath.lastIndexOf('node_modules/')
  return cut < 0 ? lockPath : lockPath.slice(cut + 'node_modules/'.length)
}

/** Dependabot's known defect: a package the root declares under optionalDependencies reappears under dependencies, which turns an optional install into a required one. */
function rootReclassifications(oldRoot, newRoot) {
  const moved = []
  for (const name of Object.keys(oldRoot?.optionalDependencies ?? {})) {
    if (newRoot?.dependencies?.[name] !== undefined) moved.push({ name, from: 'optionalDependencies', to: 'dependencies' })
  }
  return moved
}

export function diffLocks(oldLock, newLock) {
  const before = oldLock?.packages ?? {}
  const after = newLock?.packages ?? {}
  const diff = { added: [], removed: [], changed: [], flagChanges: [], dependencyChanges: [], newInstallScripts: [], rootReclassified: rootReclassifications(before[''], after['']) }
  for (const [lockPath, entry] of Object.entries(after)) {
    if (lockPath === '') continue
    const old = before[lockPath]
    if (!old) {
      diff.added.push({ path: lockPath, name: packageName(lockPath, entry), version: entry.version })
      if (entry.hasInstallScript) diff.newInstallScripts.push(lockPath)
      continue
    }
    if (old.version !== entry.version || old.integrity !== entry.integrity) {
      diff.changed.push({ path: lockPath, name: packageName(lockPath, entry), from: old.version, to: entry.version, integrityChanged: old.integrity !== entry.integrity })
    }
    for (const flag of FLAGS) {
      const was = old[flag] === true
      const now = entry[flag] === true
      if (was !== now) diff.flagChanges.push({ path: lockPath, flag, from: was, to: now })
    }
    for (const field of DEPENDENCY_FIELDS) {
      const was = old[field] ?? {}
      const now = entry[field] ?? {}
      for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (was[name] !== now[name]) diff.dependencyChanges.push({ path: lockPath, field, name, from: was[name] ?? null, to: now[name] ?? null })
      }
    }
    if (entry.hasInstallScript && !old.hasInstallScript) diff.newInstallScripts.push(lockPath)
  }
  for (const [lockPath, old] of Object.entries(before)) {
    if (lockPath !== '' && !after[lockPath]) diff.removed.push({ path: lockPath, name: packageName(lockPath, old), version: old.version })
  }
  return diff
}

export function formatDiff(diff) {
  const lines = []
  for (const item of diff.added) lines.push(`added    ${item.path} ${item.version}`)
  for (const item of diff.removed) lines.push(`removed  ${item.path} ${item.version}`)
  for (const item of diff.changed) lines.push(`changed  ${item.path} ${item.from} -> ${item.to}${item.integrityChanged ? ' (integrity changed)' : ''}`)
  for (const item of diff.flagChanges) lines.push(`flag     ${item.path} ${item.flag}: ${item.from} -> ${item.to}`)
  for (const item of diff.dependencyChanges) lines.push(`deps     ${item.path} ${item.field} ${item.name}: ${item.from ?? '(none)'} -> ${item.to ?? '(none)'}`)
  for (const item of diff.rootReclassified) lines.push(`root     ${item.name} moved from ${item.from} to ${item.to}`)
  for (const item of diff.newInstallScripts) lines.push(`note     ${item} now has an install script`)
  return lines
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function inPool(items, limit, fn) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  })
  await Promise.all(workers)
}

/** `at` is the moment the commit was made: a package published inside `cooldownDays` of it was not yet cooled down. Returns `{ diff, violations }`, each violation `{ kind, path, message }` with kind `cooldown`, `integrity`, `lookup`, `optional-lost`, `reclassified`, `install-script`, `integrity-same-version` or `inconsistent`. */
export async function auditLockChange({ oldLock, newLock, overrides, cooldownDays, at, lookup }) {
  const diff = diffLocks(oldLock, newLock)
  const violations = []

  for (const item of diff.flagChanges) {
    if (item.flag === 'optional' && item.from === true && item.to === false) {
      violations.push({ kind: 'optional-lost', path: item.path, message: `${item.path} was optional and is now required, so an install with --omit=optional grows` })
    }
  }
  for (const item of diff.rootReclassified) {
    violations.push({ kind: 'reclassified', path: '', message: `the root package declares ${item.name} under dependencies now, where it was under optionalDependencies` })
  }
  for (const lockPath of diff.newInstallScripts) {
    violations.push({ kind: 'install-script', path: lockPath, message: `${lockPath} now runs an install script (preinstall, install or postinstall), which executes on every machine that installs it` })
  }
  for (const item of diff.changed) {
    if (item.integrityChanged && item.from === item.to) {
      violations.push({ kind: 'integrity-same-version', path: item.path, message: `${item.path} ${item.to} has a different integrity than the same version had before` })
    }
  }

  const arrivals = [...diff.added, ...diff.changed.filter((item) => item.from !== item.to).map((item) => ({ path: item.path, name: item.name, version: item.to }))]
  const cache = new Map()
  const cutoff = at.getTime() - cooldownDays * DAY_MS
  await inPool(arrivals, 6, async (arrival) => {
    const entry = newLock.packages[arrival.path]
    if (typeof entry.resolved !== 'string' || !/^https?:/.test(entry.resolved)) return
    const key = `${arrival.name}@${arrival.version}`
    if (!cache.has(key)) {
      cache.set(key, Promise.resolve().then(() => lookup(arrival.name, arrival.version)).then((info) => ({ info }), (error) => ({ error })))
    }
    const outcome = await cache.get(key)
    if (outcome.error || !outcome.info) {
      violations.push({ kind: 'lookup', path: arrival.path, message: `${key} could not be checked against the registry (${outcome.error?.message ?? 'no answer'})` })
      return
    }
    const { publishedAt, integrity } = outcome.info
    const published = Date.parse(publishedAt ?? '')
    if (Number.isNaN(published)) {
      violations.push({ kind: 'lookup', path: arrival.path, message: `${key} has no publish time in the registry's answer, so the cooldown cannot be checked` })
    } else if (published > cutoff) {
      violations.push({ kind: 'cooldown', path: arrival.path, message: `${key} was published ${publishedAt}, inside the ${cooldownDays}-day cooldown before ${at.toISOString()}` })
    }
    if (integrity !== entry.integrity) {
      violations.push({ kind: 'integrity', path: arrival.path, message: `${key} has integrity ${entry.integrity} in the lock but the registry serves ${integrity}` })
    }
  })

  for (const problem of checkLockConsistency(newLock, { overrides })) {
    violations.push({ kind: 'inconsistent', path: problem.dependent, message: formatProblem(problem) })
  }
  return { diff, violations }
}

/** Reads `npm view <name>@<version> dist.integrity time --json` output; `tests/lock_audit.test.ts` carries a CAPTURE of it. */
export function parseNpmView(stdout, version) {
  let parsed = JSON.parse(stdout)
  if (Array.isArray(parsed)) parsed = parsed[parsed.length - 1]
  return { integrity: parsed?.['dist.integrity'] ?? null, publishedAt: parsed?.time?.[version] ?? null }
}

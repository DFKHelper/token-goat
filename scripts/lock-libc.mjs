/** npm 11.6.2 rewrites package-lock.json without the `libc` field of the optional platform packages (musl and glibc builds of the same package differ only in it), so a refresh run on that npm left 16 entries bare and a hand step put them back. `restoreLibc` is that step: an entry that did not move keeps the `libc` the pre-refresh lock gave it, and an entry that is new or moved gets the registry manifest's. `findMissingLibc` is the check that no entry is bare: a Linux platform package whose registry manifest declares `libc` but whose lock entry has none. Both ask the registry through an injected `lookup(name, version) -> { libc }` (an array of `glibc`/`musl`, or null when the manifest declares none), so tests run with no network; a package the lookup cannot answer for is reported, never skipped. */

/** The registry name a lock path installs: the segment after the last node_modules/, or the `name` an aliased entry records. */
function nameOf(lockPath, entry) {
  if (typeof entry?.name === 'string') return entry.name
  const cut = lockPath.lastIndexOf('node_modules/')
  return cut < 0 ? lockPath : lockPath.slice(cut + 'node_modules/'.length)
}

/** Only a package that installs on Linux can declare libc; every other platform package is exempt without a lookup. */
function installsOnLinux(entry) {
  return Array.isArray(entry?.os) && entry.os.includes('linux')
}

/** The lock paths of Linux platform packages with no `libc`, the only ones whose registry manifest could disagree. A linked or non-registry entry has no manifest to ask. */
export function bareLinuxPackages(lock) {
  const found = []
  for (const [lockPath, entry] of Object.entries(lock?.packages ?? {})) {
    if (lockPath === '' || entry.link === true || entry.libc !== undefined || !installsOnLinux(entry)) continue
    if (typeof entry.resolved !== 'string' || !/^https?:/.test(entry.resolved)) continue
    found.push(lockPath)
  }
  return found
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function inPool(items, limit, fn) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  })
  await Promise.all(workers)
}

/** Answers `lookup` once per name@version, as `{ libc }` or `{ error }`. */
function cachedLookup(lookup) {
  const cache = new Map()
  return (name, version) => {
    const key = `${name}@${version}`
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => lookup(name, version)).then((info) => ({ libc: Array.isArray(info?.libc) && info.libc.length > 0 ? info.libc : null }), (error) => ({ error })))
    return cache.get(key)
  }
}

/** The entry with `libc` placed where npm puts it: among the keys after `integrity`, which npm writes alphabetically, so the lock diff shows one added line and no reordering. */
function withLibc(entry, libc) {
  const keys = Object.keys(entry)
  const at = keys.findIndex((key, index) => index >= 3 && key > 'libc')
  const out = {}
  keys.forEach((key, index) => {
    if (index === (at < 0 ? keys.length : at)) out.libc = libc
    out[key] = entry[key]
  })
  if (at < 0) out.libc = libc
  return out
}

/** Puts the `libc` npm dropped back into `newLock` in place. Returns `{ restored, unresolved }`: `restored` is `[{ path, libc, source }]` with source `previous lock` or `registry`, `unresolved` is `[{ path, message }]` for an entry the registry could not be asked about. An entry the old lock carried unchanged and bare stays bare: nothing moved, so nothing was stripped. */
export async function restoreLibc({ oldLock, newLock, lookup }) {
  const restored = []
  const unresolved = []
  const ask = cachedLookup(lookup)
  const before = oldLock?.packages ?? {}
  const pending = []
  for (const lockPath of bareLinuxPackages(newLock)) {
    const entry = newLock.packages[lockPath]
    const old = before[lockPath]
    if (old && old.version === entry.version) {
      if (old.libc !== undefined) {
        newLock.packages[lockPath] = withLibc(entry, old.libc)
        restored.push({ path: lockPath, libc: old.libc, source: 'previous lock' })
      }
      continue
    }
    pending.push(lockPath)
  }
  await inPool(pending, 6, async (lockPath) => {
    const entry = newLock.packages[lockPath]
    const answer = await ask(nameOf(lockPath, entry), entry.version)
    if (answer.error) {
      unresolved.push({ path: lockPath, message: `${lockPath} ${entry.version} could not be checked for libc against the registry (${answer.error.message})` })
    } else if (answer.libc) {
      newLock.packages[lockPath] = withLibc(entry, answer.libc)
      restored.push({ path: lockPath, libc: answer.libc, source: 'registry' })
    }
  })
  return { restored, unresolved }
}

/** Problems `[{ path, message }]`: a Linux platform package whose registry manifest declares libc and whose lock entry lacks it, and one the registry could not be asked about. */
export async function findMissingLibc({ lock, lookup }) {
  const problems = []
  const ask = cachedLookup(lookup)
  await inPool(bareLinuxPackages(lock), 6, async (lockPath) => {
    const entry = lock.packages[lockPath]
    const answer = await ask(nameOf(lockPath, entry), entry.version)
    if (answer.error) problems.push({ path: lockPath, message: `${lockPath} ${entry.version} could not be checked for libc against the registry (${answer.error.message})` })
    else if (answer.libc) problems.push({ path: lockPath, message: `${lockPath} ${entry.version} has no libc in the lock, but the registry declares libc ${JSON.stringify(answer.libc)} for it` })
  })
  return problems.sort((a, b) => a.path.localeCompare(b.path))
}

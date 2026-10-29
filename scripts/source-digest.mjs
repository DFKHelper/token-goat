import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, opendirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

const MAX_DIGEST_ENTRIES = 4096
const MAX_DIGEST_FILES = 2048
const MAX_DIGEST_BYTES = 64 * 1024 * 1024

/** Where esbuild.config.mjs records the digest of the sources it built from. Outside dist/ because package.json's `files` ships that directory whole. */
export function bundleStampPath(root) {
  return path.join(root, 'node_modules', '.cache', 'token-goat', 'bundle-source.sha256')
}

const LOCAL_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g

function isOutside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

function resolveSourcePath(root, rel, missingOk = false) {
  const candidate = path.resolve(root, rel)
  if (isOutside(root, candidate)) throw new Error(`${rel}: source digest path resolves outside the repository`)
  let real
  try {
    real = realpathSync(candidate)
  } catch (error) {
    if (missingOk && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')) return null
    throw error
  }
  if (isOutside(root, real)) throw new Error(`${rel}: source digest path resolves outside the repository`)
  return real
}

/** esbuild.config.mjs and every local module it reaches through relative imports, root-relative with `/` separators. Followed rather than listed, because the build options live in scripts/build-options.mjs: a list that named only the config missed an edit there, and the next test run spawned a bundle built with the old defines. A specifier that names no file, such as the `import('./token-goat.core.mjs')` quoted inside the launcher banner, is skipped. */
export function buildScripts(root) {
  const rootReal = realpathSync(root)
  const seen = new Set()
  const stack = ['esbuild.config.mjs']
  let bytesRead = 0
  let importCount = 0
  while (stack.length > 0) {
    const rel = stack.pop()
    if (seen.has(rel)) continue
    const file = resolveSourcePath(rootReal, rel, true)
    if (file === null) continue
    const stat = statSync(file)
    if (!stat.isFile()) continue
    if (seen.size >= MAX_DIGEST_FILES) throw new Error(`source digest exceeds the ${MAX_DIGEST_FILES}-file limit`)
    if (bytesRead + stat.size > MAX_DIGEST_BYTES) throw new Error(`source digest exceeds the ${MAX_DIGEST_BYTES}-byte limit`)
    const bytes = readFileSync(file)
    bytesRead += bytes.length
    if (bytesRead > MAX_DIGEST_BYTES) throw new Error(`source digest exceeds the ${MAX_DIGEST_BYTES}-byte limit`)
    const text = bytes.toString('utf8')
    seen.add(rel)
    for (const m of text.matchAll(LOCAL_IMPORT)) {
      if (++importCount > MAX_DIGEST_ENTRIES) throw new Error(`source digest exceeds the ${MAX_DIGEST_ENTRIES}-entry limit`)
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])))
    }
  }
  return [...seen]
}

/** Build inputs besides the sources, hashed when present. esbuild reads tsconfig.json (verbatimModuleSyntax and useDefineForClassFields change what it emits), and package-lock.json pins esbuild itself and every package the bundle inlines, which `npm run deps:refresh` changes without touching package.json. */
const OPTIONAL_INPUTS = ['package-lock.json', 'tsconfig.json']

/** What a directory entry is once a symbolic link or junction is followed, or null for a dangling link. */
function entryKind(full, entry) {
  if (!entry.isSymbolicLink()) return entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : null
  try {
    const st = statSync(full)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
  } catch {
    return null
  }
}

/** One sha256 over everything the bundle is built from: src/**, package.json, the optional inputs above, esbuild.config.mjs and the local modules it imports, each as its root-relative path with `/` separators followed by its bytes, in sorted path order. Content rather than mtime, because an mtime says when a file was last written, not what it holds: restoring a file from a backup with `mv`, `cp -p` or a stash can put back older sources under an older timestamp, and a bundle built from the edited copy in between then looks newer than its sources while being built from different ones. Symbolic links and junctions under src/ are followed, as esbuild follows them; a directory already walked under another name is not walked again, so a link back to an ancestor ends. Hashing all of src/ costs about 35 ms. */
export function sourceDigest(root) {
  const rootReal = realpathSync(root)
  const files = ['package.json', ...OPTIONAL_INPUTS.filter((rel) => existsSync(path.join(rootReal, rel))), ...buildScripts(rootReal)]
  const stack = ['src']
  const walked = new Set()
  let entriesRead = 0
  while (stack.length > 0) {
    const dir = stack.pop()
    const real = resolveSourcePath(rootReal, dir)
    if (walked.has(real)) continue
    walked.add(real)
    const entries = opendirSync(real)
    try {
      let entry
      while ((entry = entries.readSync()) !== null) {
        if (++entriesRead > MAX_DIGEST_ENTRIES) throw new Error(`source digest exceeds the ${MAX_DIGEST_ENTRIES}-entry limit`)
        const rel = `${dir}/${entry.name}`
        const kind = entryKind(path.join(rootReal, rel), entry)
        if (kind === 'dir') stack.push(rel)
        else if (kind === 'file') {
          if (entry.isSymbolicLink()) resolveSourcePath(rootReal, rel)
          files.push(rel)
          if (files.length > MAX_DIGEST_FILES) throw new Error(`source digest exceeds the ${MAX_DIGEST_FILES}-file limit`)
        }
      }
    } finally {
      entries.closeSync()
    }
  }
  files.sort()
  const hash = createHash('sha256')
  let bytesRead = 0
  for (const rel of files) {
    const file = resolveSourcePath(rootReal, rel)
    if (file === null) throw new Error(`${rel}: source digest input is missing`)
    const size = statSync(file).size
    if (bytesRead + size > MAX_DIGEST_BYTES) throw new Error(`source digest exceeds the ${MAX_DIGEST_BYTES}-byte limit`)
    const bytes = readFileSync(file)
    bytesRead += bytes.length
    if (bytesRead > MAX_DIGEST_BYTES) throw new Error(`source digest exceeds the ${MAX_DIGEST_BYTES}-byte limit`)
    // Path and length both go in ahead of the bytes, so moving content from one file to the next, or renaming a file, changes the digest.
    hash.update(`${rel}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

export function readBundleStamp(root) {
  try {
    return readFileSync(bundleStampPath(root), 'utf8').trim()
  } catch {
    return null
  }
}

/** Dropped before a build starts and written only once it has finished, so a build that fails partway leaves no stamp and the next test run rebuilds. */
export function clearBundleStamp(root) {
  rmSync(bundleStampPath(root), { force: true })
}

/** Best-effort: a stamp that cannot be written costs the next test run one rebuild, which is no reason to fail a build that produced a good dist/. */
export function writeBundleStamp(root, digest) {
  const file = bundleStampPath(root)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${digest}\n`)
  } catch {
    // Nothing to add: without a stamp the test setup rebuilds.
  }
}

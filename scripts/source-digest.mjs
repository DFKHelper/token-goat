import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

/** Where esbuild.config.mjs records the digest of the sources it built from. Outside dist/ because package.json's `files` ships that directory whole. */
export function bundleStampPath(root) {
  return path.join(root, 'node_modules', '.cache', 'token-goat', 'bundle-source.sha256')
}

const LOCAL_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g

/** esbuild.config.mjs and every local module it reaches through relative imports, root-relative with `/` separators. Followed rather than listed, because the build options live in scripts/build-options.mjs: a list that named only the config missed an edit there, and the next test run spawned a bundle built with the old defines. A specifier that names no file, such as the `import('./token-goat.core.mjs')` quoted inside the launcher banner, is skipped. */
export function buildScripts(root) {
  const seen = new Set()
  const stack = ['esbuild.config.mjs']
  while (stack.length > 0) {
    const rel = stack.pop()
    if (seen.has(rel)) continue
    let text
    try {
      if (!statSync(path.join(root, rel)).isFile()) continue
      text = readFileSync(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    seen.add(rel)
    for (const m of text.matchAll(LOCAL_IMPORT)) stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])))
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
  const files = ['package.json', ...OPTIONAL_INPUTS.filter((rel) => existsSync(path.join(root, rel))), ...buildScripts(root)]
  const stack = ['src']
  const walked = new Set()
  while (stack.length > 0) {
    const dir = stack.pop()
    const real = realpathSync(path.join(root, dir))
    if (walked.has(real)) continue
    walked.add(real)
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      const kind = entryKind(path.join(root, rel), entry)
      if (kind === 'dir') stack.push(rel)
      else if (kind === 'file') files.push(rel)
    }
  }
  files.sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    const bytes = readFileSync(path.join(root, rel))
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

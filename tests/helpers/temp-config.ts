// Unique-per-run temp path for a test that redirects `constants.js::configPath()` (or a test DB path) at a real file on disk. Never key such a path on `process.pid`: the OS temp dir is shared across runs and pids are recycled, so a file this run's fork writes (e.g. the `image_shrink.enabled = false` config the last test in tests/hooks_browser_image.test.ts saves) is still there when a *later* run's fork gets the same pid, and that stale config becomes the later run's starting state -- an order-dependent, cross-run leak that flips assertions in a file that passes in isolation. Every call gets its own subdirectory of one `mkdtempSync` root per process, so it can never collide with another run or another caller. The root is removed on process exit; because a forked vitest worker can be killed before that hook runs, roots older than a day are also swept opportunistically.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_PREFIX = 'tg-test-cfg-'
const STALE_ROOT_MS = 24 * 60 * 60 * 1000

// The dirty queue refuses anything under the OS temp dir (see src/project.ts::isUnderSystemTemp), so a fixture whose files must reach the index lives under the repo's gitignored .tmp/ instead.
const INDEXABLE_BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp')

const roots = new Map<string, string>()
let counter = 0

/** Best-effort removal of roots left behind by runs whose workers were killed before the exit hook fired. A day-old cutoff keeps this from touching a concurrently running suite. */
function sweepStaleRoots(base: string): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(base)
  } catch {
    return
  }
  const cutoff = Date.now() - STALE_ROOT_MS
  for (const name of entries) {
    if (!name.startsWith(ROOT_PREFIX)) continue
    const full = path.join(base, name)
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true })
    } catch {
      /* another run may be using or removing it */
    }
  }
}

/** Returns `<fresh dir>/<fileName>`; the file itself is not created. */
export function tempConfigPath(fileName: string): string {
  return path.join(tempDir(), fileName)
}

/** A fresh empty directory under this process's temp root, removed with the root on exit. Callers never clean up after themselves, so a directory survives a failing assertion for debugging and is still not leaked. */
export function tempDir(): string {
  return dirUnder(os.tmpdir())
}

/** Like {@link tempDir}, but outside the OS temp dir, for a fixture whose files the dirty queue must accept. It sits inside this repository's work tree, so it is never a non-git directory. */
export function indexableDir(): string {
  return dirUnder(INDEXABLE_BASE)
}

function dirUnder(base: string): string {
  let root = roots.get(base)
  if (root === undefined) {
    fs.mkdirSync(base, { recursive: true })
    root = fs.mkdtempSync(path.join(base, ROOT_PREFIX))
    roots.set(base, root)
    sweepStaleRoots(base)
  }
  const dir = path.join(root, String(counter++))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

process.on('exit', () => {
  for (const root of roots.values()) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* best effort: a locked sqlite file must not fail the run */
    }
  }
})

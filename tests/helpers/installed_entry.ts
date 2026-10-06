import * as path from 'node:path'

/** Points process.argv[1] at an installed bundle's path under `base` and returns the restore. Install bakes process.argv[1] into every hook command it writes, and uninstall and the installed check know token-goat's own entries by a `token-goat` path segment in it; under vitest argv[1] is the pool's worker script, which carries that segment only when the checkout's own directory happens to be named token-goat, so a test that installs without this passes or fails by where the repository was cloned. */
export function pinInstalledEntry(base: string): () => void {
  const original = process.argv[1]
  process.argv[1] = path.join(base, 'node_modules', 'token-goat', 'dist', 'token-goat.mjs')
  return () => {
    process.argv[1] = original as string
  }
}

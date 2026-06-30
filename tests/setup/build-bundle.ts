import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// vitest globalSetup: build the shipping bundle (dist/token-goat.mjs) exactly once per `vitest` invocation, before any test file runs. The e2e and CLI smoke tests spawn this prebuilt artifact, so without this each of them rebuilt it in its own beforeAll - six redundant esbuild runs that also raced on the same output path. One build here replaces all of them. Note: in watch mode this runs once at startup and not on source edits, so a bundle-spawning test will see stale dist until the watcher is restarted; the gating path (`vitest run` in CI and pre-push) rebuilds fresh on every invocation.
export default function setup(): void {
  execFileSync(process.execPath, ['esbuild.config.mjs'], { cwd: ROOT, stdio: 'ignore' })
}

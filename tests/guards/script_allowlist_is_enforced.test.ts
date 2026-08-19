/**
 * A package.json install-script allowlist must have a tool that reads it.
 *
 * Why didn't a test catch this: `allowScripts` sat in package.json for months
 * naming the exact packages permitted to run install scripts, which reads like a
 * supply-chain control. Nothing installed `@lavamoat/allow-scripts`, no npm
 * script invoked it, and no CI job checked it, so the list enforced nothing and
 * quietly drifted -- by the time it was found it still pinned better-sqlite3
 * 11.10.0 and tree-sitter 0.22.4, versions the tree had long since left behind.
 * A stale allowlist that looks like a gate is worse than no allowlist, because a
 * reviewer trusts it. This test fails if the key comes back without its tool.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '..', '..')

function readManifest(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as Record<string, unknown>
}

describe('install-script allowlist', () => {
  for (const manifest of ['package.json', 'vscode-extension/package.json']) {
    it(`${manifest}: declares no allowlist without the tool that enforces it`, () => {
      const pkg = readManifest(manifest)
      if (pkg.allowScripts === undefined) return
      const deps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
      }
      expect(
        Object.keys(deps).some((d) => d === '@lavamoat/allow-scripts'),
        `${manifest} has an "allowScripts" allowlist but no @lavamoat/allow-scripts dependency to read it, so it gates nothing`,
      ).toBe(true)
    })
  }
})

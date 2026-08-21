/**
 * Guard: every file an npm lifecycle script runs must actually be inside the published package.
 *
 * `package.json` is always included in a tarball, even when `files` lists nothing else -- so a
 * lifecycle script survives into the published manifest whether or not the file it points at does.
 * This project shipped exactly that: `"prepare": "node scripts/install-git-hooks.mjs"` in every
 * published manifest, with `scripts/` absent from the `files` allowlist. A plain
 * `npm install token-goat` never noticed, because npm does not run a dependency's `prepare` on a
 * registry install. Installing the package as a directory does run it, and it died on
 * `MODULE_NOT_FOUND` for a file the tarball never carried.
 *
 * Why didn't a test catch it: the existing prepare-script test copies the real script into a temp
 * project and asserts how it behaves, which is a question about the script, not about whether the
 * script is shipped. Nothing compared the `scripts` field against the `files` field at all, so a
 * manifest naming a file it does not publish satisfied every test in the suite.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..', '..')

/** Lifecycle names npm runs by itself. A script only reachable through `npm run` is not one. */
const LIFECYCLE = [
  'preinstall', 'install', 'postinstall',
  'preprepare', 'prepare', 'postprepare',
  'prepack', 'postpack',
]

/** Local file paths a script shell-invokes, e.g. the `scripts/x.mjs` in `node scripts/x.mjs`. */
function referencedPaths(command: string): string[] {
  const out: string[] = []
  for (const token of command.split(/\s+/)) {
    const bare = token.replace(/^["']|["']$/g, '')
    if (/^[\w./-]+\.(mjs|cjs|js|ts|sh)$/.test(bare) && !bare.startsWith('-')) out.push(bare.replace(/^\.\//, ''))
  }
  return out
}

/** Whether one `files` entry publishes `target`. A trailing slash makes an entry a directory. */
function entryCovers(entry: string, target: string): boolean {
  const e = entry.replace(/^\.\//, '')
  if (e === target) return true
  const dir = e.endsWith('/') ? e : e + '/'
  return target.startsWith(dir)
}

describe('published package carries every file its lifecycle scripts run', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
    files?: string[]
  }
  const scripts = manifest.scripts ?? {}
  const files = manifest.files ?? []

  it('names at least one lifecycle script, so this guard is not vacuously green', () => {
    const present = LIFECYCLE.filter((name) => typeof scripts[name] === 'string')
    expect(present, 'no lifecycle script found -- if one was removed, delete this guard deliberately').not.toHaveLength(0)
  })

  for (const name of LIFECYCLE) {
    const command = scripts[name]
    if (command === undefined) continue

    it(`ships every file the ${name} script runs`, () => {
      const referenced = referencedPaths(command)
      expect(referenced, `the ${name} script runs no recognisable local file: ${command}`).not.toHaveLength(0)

      for (const target of referenced) {
        expect(
          fs.existsSync(path.join(ROOT, target)),
          `the ${name} script runs ${target}, which does not exist in the repo`,
        ).toBe(true)
        expect(
          files.some((entry) => entryCovers(entry, target)),
          `the ${name} script runs ${target}, but the files allowlist does not publish it, so an install that runs ${name} fails with MODULE_NOT_FOUND`,
        ).toBe(true)
      }
    })
  }
})

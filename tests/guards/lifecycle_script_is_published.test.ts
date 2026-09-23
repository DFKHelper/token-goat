/** Guard: every file an npm lifecycle script runs must actually be inside the published package. `package.json` is always included in a tarball, even when `files` lists nothing else -- so a lifecycle script survives into the published manifest whether or not the file it points at does. This project shipped exactly that: `"prepare": "node scripts/install-git-hooks.mjs"` in every published manifest, with `scripts/` absent from the `files` allowlist. A plain `npm install token-goat` never noticed, because npm does not run a dependency's `prepare` on a registry install. Installing the package as a directory does run it, and it died on `MODULE_NOT_FOUND` for a file the tarball never carried. Why didn't a test catch it: the existing prepare-script test copies the real script into a temp project and asserts how it behaves, which is a question about the script, not about whether the script is shipped. Nothing compared the `scripts` field against the `files` field at all, so a manifest naming a file it does not publish satisfied every test in the suite. */
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

/** The three npm runs on `npm install` of a published tarball -- the ones a consumer cannot opt out of short of `--ignore-scripts`. */
const INSTALL_TIME = ['preinstall', 'install', 'postinstall'] as const

/** Lifecycle scripts this package is allowed to declare, with what each is for. `prepare` is not in INSTALL_TIME because npm does not run it for a registry tarball -- only for a git dependency or a local `npm install` in the package directory -- and `scripts/install-git-hooks.mjs` exits 0 when lefthook is absent, which is every context except a dev checkout. */
const ALLOWED: ReadonlyMap<string, string> = new Map([['prepare', 'wires lefthook into a dev checkout; a no-op anywhere else']])

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

  const present = LIFECYCLE.filter((name) => typeof scripts[name] === 'string')

  it('names at least one lifecycle script, so this guard is not vacuously green', () => {
    expect(present, 'no lifecycle script found -- if one was removed, delete this guard deliberately').not.toHaveLength(0)
    // The positive control for the two checks below: both read `present`, so a manifest read that returned nothing would agree with either of them for the wrong reason.
    expect(present, 'the one lifecycle script this package declares is gone').toContain('prepare')
  })

  it('runs nothing at all when a consumer installs it', () => {
    // The whole point of the current npm supply-chain class is that it no longer needs an install hook -- but a package that also declares one hands an attacker the older, easier route back, and this package has never needed one. Keeping the count at zero is a property worth being told about the moment it changes, not a fact to rediscover during an incident.
    expect(
      INSTALL_TIME.filter((name) => typeof scripts[name] === 'string'),
      'installing this package would now execute code on a consumer machine before anything is imported',
    ).toEqual([])
  })

  it('declares no lifecycle script that has not been reviewed', () => {
    expect(
      present.filter((name) => !ALLOWED.has(name)),
      'a new lifecycle script means npm runs this by itself in contexts nobody chose; decide what it is for, then add it to ALLOWED',
    ).toEqual([])
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

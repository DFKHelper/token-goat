/**
 * Dependabot watched the GitHub Actions pins and nothing else, so every npm advisory in this tree
 * waited on somebody noticing it by hand, and the extension's own lockfile was watched by nobody at
 * all. It also had no `cooldown`, which is the control that matters most for npm specifically: the
 * account-takeover pattern is a malicious version published, installed by whoever updates first,
 * and yanked hours later. Proposing an update the day it is published puts this repository in that
 * first group. Seven days does not make a package safe; it means somebody else finds out first.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Update {
  'package-ecosystem': string
  directory: string
  cooldown?: { 'default-days'?: number }
}

function updates(): Update[] {
  const text = fs.readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8')
  return (yaml.load(text) as { updates?: Update[] }).updates ?? []
}

describe('dependabot coverage', () => {
  const entries = updates()

  it('parses the config and finds entries, so an empty file cannot pass as a covered one', () => {
    expect(entries.length).toBeGreaterThanOrEqual(3)
  })

  it.each(entries.map((u) => [`${u['package-ecosystem']} ${u.directory}`, u]))(
    '%s waits out the publish window before proposing an update',
    (_label, update) => {
      const days = (update as Update).cooldown?.['default-days']

      expect(days, 'without a cooldown this proposes a version the day it is published').toBeDefined()
      expect(days as number).toBeGreaterThanOrEqual(7)
    },
  )

  // Both manifests, not just the root one. An update to the root tree never reaches the extension.
  it.each([['/'], ['/vscode-extension']])('watches the npm tree in %s', (directory) => {
    const covered = entries.some((u) => u['package-ecosystem'] === 'npm' && u.directory === directory)

    expect(covered, 'nothing proposes dependency updates for this manifest').toBe(true)
  })

  it('still watches the action pins, which are the reason the file exists', () => {
    expect(entries.some((u) => u['package-ecosystem'] === 'github-actions')).toBe(true)
  })

  // A directory that does not exist is watched by nobody, and Dependabot says so only in its own
  // logs. Renaming a folder is the ordinary way this goes quiet.
  it.each(entries.map((u) => [u.directory]))('%s holds the manifest it claims to watch', (directory) => {
    const dir = path.join(repoRoot, directory as string)

    expect(fs.existsSync(dir), `${directory} does not exist`).toBe(true)
    if ((entries.find((u) => u.directory === directory) as Update)['package-ecosystem'] === 'npm') {
      expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true)
    }
  })
})

/**
 * Guard: every directory this repository keeps first-party code in is named by the `lint` script.
 *
 * `scripts/` sat outside the linter entirely for the life of the project. Nothing reported that,
 * because a directory eslint is never pointed at produces no findings at all -- the same clean
 * output as a directory with nothing wrong. When it was finally pointed at, it had 41 `no-undef`
 * errors, every one of them a Node runtime global against a config that declared no environment.
 *
 * CI runs exactly one lint command (`npm run lint`, in the `lint` job), so covering a directory in
 * CI and naming it in that script are the same thing. This guard reads the script string and the
 * flat config, rather than running eslint, so it stays fast and states a wiring fact.
 *
 * What it cannot catch: a directory added later that nobody lists here, and a config block that
 * names a directory but disables the rules that matter in it. It checks the wiring, not the rules.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
const ESLINT_CONFIG = readFileSync(path.join(ROOT, 'eslint.config.mjs'), 'utf8')
const CI = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

/** Every directory holding first-party code that a reviewer would expect the linter to have read. */
const LINTED_DIRS = ['src', 'tests', 'scripts', 'vscode-extension/src', 'vscode-extension/tests'] as const

describe('lint covers every first-party source directory', () => {
  it('names each directory in the lint script', () => {
    const lint = PKG.scripts['lint']
    expect(lint, 'package.json has no lint script').toBeDefined()
    const args = lint!.split(/\s+/).slice(1)
    expect(LINTED_DIRS.length).toBeGreaterThan(0)
    expect(LINTED_DIRS.filter((d) => !args.includes(d))).toEqual([])
  })

  it('gives scripts/ a Node environment, so its globals are declared rather than the rule switched off', () => {
    // Anchored to the config block added when the directory came under lint: `process` is what 39 of the 41 original errors named, and `no-undef` staying on is what makes the block a fix rather than a suppression.
    expect(ESLINT_CONFIG).toContain("files: ['scripts/**/*.mjs']")
    expect(ESLINT_CONFIG).toContain("process: 'readonly'")
    expect(ESLINT_CONFIG).not.toMatch(/'no-undef':\s*'off'/)
  })

  it('runs that one lint script in CI, which is what makes naming a directory there cover it', () => {
    expect(CI).toContain('npm run lint')
  })
})

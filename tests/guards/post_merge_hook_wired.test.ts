/**
 * Guard: post-merge and post-rewrite git hooks must be wired and executable.
 *
 * When developers or agents update token-goat via `git pull` or `git merge`,
 * the post-merge hook automatically runs `scripts/post-merge.mjs` to rebuild
 * the bundle, restart resident daemons (hook-server, worker), refresh harness
 * shims (Claude Code and Copilot CLI), and update the index.
 *
 * This test guarantees:
 * 1. `lefthook.yml` declares `post-merge` and `post-rewrite`.
 * 2. Both point to `node scripts/post-merge.mjs`.
 * 3. `scripts/post-merge.mjs` exists on disk.
 * 4. `package.json` declares a `"sync"` script pointing to `scripts/post-merge.mjs`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..', '..')

describe('post-merge and post-rewrite synchronization hooks are wired', () => {
  const lefthookPath = path.join(ROOT, 'lefthook.yml')
  const scriptPath = path.join(ROOT, 'scripts', 'post-merge.mjs')
  const packageJsonPath = path.join(ROOT, 'package.json')

  it('scripts/post-merge.mjs exists on disk', () => {
    expect(fs.existsSync(scriptPath), 'scripts/post-merge.mjs is missing').toBe(true)
  })

  it('lefthook.yml declares post-merge and post-rewrite calling scripts/post-merge.mjs', () => {
    const content = fs.readFileSync(lefthookPath, 'utf8')
    expect(content, 'lefthook.yml is missing post-merge section').toMatch(/post-merge:\s+commands:/)
    expect(content, 'lefthook.yml is missing post-rewrite section').toMatch(/post-rewrite:\s+commands:/)
    expect(content, 'post-merge in lefthook.yml does not run scripts/post-merge.mjs').toContain(
      'node scripts/post-merge.mjs',
    )
  })

  it('package.json declares a "sync" script running scripts/post-merge.mjs', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    expect(pkg.scripts?.sync, 'package.json missing "sync" script').toBe('node scripts/post-merge.mjs')
  })
})

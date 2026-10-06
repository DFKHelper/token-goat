// scripts/post-merge.mjs runs after every pull, merge and rebase, and past the build it acts on the user's real home: hook-server stop, worker restart, install, doctor --repair, prune and index. Run from a linked worktree it re-pointed every installed hook at that worktree's dist and started a worker there, so a linked worktree must stop after the build. CAPTURE: the repositories are real (`git init`, `git commit`, `git worktree add`) and the script is the shipped one, copied beside a stub bundle that only records the arguments it was run with.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { gitRepoWithCommit } from './helpers/git-repo.js'
import { tempDir } from './helpers/temp-config.js'

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'post-merge.mjs')

const STUB_BUILD = [
  "import fs from 'node:fs'",
  "fs.mkdirSync('dist', { recursive: true })",
  "fs.writeFileSync('dist/token-goat.mjs', \"import fs from 'node:fs'; fs.appendFileSync(process.env.TG_POST_MERGE_LOG, process.argv.slice(2).join(' ') + '\\\\n')\")",
  '',
].join('\n')

/** Gives `root` the shipped script plus a package.json whose build writes the recording stub bundle. */
function stageCheckout(root: string): void {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'post-merge.mjs'))
  fs.writeFileSync(path.join(root, 'build.mjs'), STUB_BUILD)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'stub', private: true, scripts: { build: 'node build.mjs' } }))
}

function runPostMerge(root: string, log: string) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'post-merge.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TG_POST_MERGE_LOG: log },
  })
}

describe('post-merge sync in a linked worktree', () => {
  it('builds but leaves the real install alone in a linked worktree, and syncs it from the main checkout', { timeout: 120_000 }, () => {
    const main = gitRepoWithCommit()
    const linked = path.join(tempDir(), 'linked')
    const added = spawnSync('git', ['worktree', 'add', '--detach', linked], { cwd: main, encoding: 'utf8' })
    expect(added.status, added.stderr).toBe(0)
    stageCheckout(main)
    stageCheckout(linked)

    const linkedLog = path.join(tempDir(), 'linked.log')
    const fromLinked = runPostMerge(linked, linkedLog)
    expect(fromLinked.status, fromLinked.stderr).toBe(0)
    expect(fs.existsSync(path.join(linked, 'dist', 'token-goat.mjs'))).toBe(true)
    expect(fromLinked.stdout).toContain('Linked worktree: built the bundle only.')
    expect(fs.existsSync(linkedLog)).toBe(false)

    const mainLog = path.join(tempDir(), 'main.log')
    const fromMain = runPostMerge(main, mainLog)
    expect(fromMain.status, fromMain.stderr).toBe(0)
    expect(fromMain.stdout).not.toContain('Linked worktree')
    expect(fs.readFileSync(mainLog, 'utf8').split(/\r?\n/).filter(Boolean)).toEqual([
      'hook-server stop',
      'worker stop',
      'worker start',
      'install',
      'install --copilot',
      'install --copilot --local',
      'doctor --repair',
      'project prune',
      'index',
    ])
  })
})

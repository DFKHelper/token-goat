// scripts/post-merge.mjs runs after every pull, merge and rebase, and past the build it acts on the user's real home: hook-server stop, worker restart, install, doctor --repair, prune and index. Run from a linked worktree it re-pointed every installed hook at that worktree's dist and started a worker there, so a linked worktree must stop after the build. CAPTURE: the repositories are real (`git init`, `git commit`, `git worktree add`) and the script is the shipped one, copied beside a stub bundle that only records the arguments it was run with.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { codexHookScriptPath } from '../src/bridges/codex_install.js'
import { copilotCliScriptPath } from '../src/bridges/copilot_cli_install.js'
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

/** Fresh home, CODEX_HOME and COPILOT_HOME, all apart from each other and from the real ones, so the script's host check never sees a developer's own Codex or Copilot install. */
function isolatedHosts(): { home: string; codexHome: string; copilotHome: string } {
  const base = tempDir()
  return { home: path.join(base, 'home'), codexHome: path.join(base, 'codex'), copilotHome: path.join(base, 'copilot') }
}

function runPostMerge(root: string, log: string, hosts = isolatedHosts()) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'post-merge.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TG_POST_MERGE_LOG: log, HOME: hosts.home, USERPROFILE: hosts.home, CODEX_HOME: hosts.codexHome, COPILOT_HOME: hosts.copilotHome },
  })
}

function writeShim(shimPath: string): void {
  fs.mkdirSync(path.dirname(shimPath), { recursive: true })
  fs.writeFileSync(shimPath, '// shim')
}

function loggedArgs(log: string): string[] {
  return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean)
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
    expect(loggedArgs(mainLog)).toEqual(['hook-server stop', 'worker stop', 'worker start', 'install', 'doctor --repair', 'project prune', 'index'])
  })
})

describe('post-merge refresh of the Codex and Copilot hosts', () => {
  const BASE = ['hook-server stop', 'worker stop', 'worker start', 'install']
  const TAIL = ['doctor --repair', 'project prune', 'index']

  /** Runs the script in a main checkout after `seed` placed shims where the product's own path functions say they belong, with CODEX_HOME and COPILOT_HOME set to the isolated directories. */
  function run(seed: (root: string) => void): string[] {
    const main = gitRepoWithCommit()
    stageCheckout(main)
    const hosts = isolatedHosts()
    const saved = { codex: process.env['CODEX_HOME'], copilot: process.env['COPILOT_HOME'] }
    process.env['CODEX_HOME'] = hosts.codexHome
    process.env['COPILOT_HOME'] = hosts.copilotHome
    try {
      seed(main)
    } finally {
      for (const [key, value] of [['CODEX_HOME', saved.codex], ['COPILOT_HOME', saved.copilot]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const log = path.join(tempDir(), 'run.log')
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    return loggedArgs(log)
  }

  it('skips Codex and Copilot, creating nothing, when no host has a token-goat shim', { timeout: 120_000 }, () => {
    const hosts = isolatedHosts()
    const main = gitRepoWithCommit()
    stageCheckout(main)
    const log = path.join(tempDir(), 'none.log')
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    expect(loggedArgs(log)).toEqual([...BASE, ...TAIL])
    expect(res.stdout).not.toContain('Codex')
    expect(res.stdout).not.toContain('Copilot')
    for (const dir of [hosts.home, hosts.codexHome, hosts.copilotHome]) expect(fs.existsSync(dir), dir).toBe(false)
  })

  it('refreshes Codex only, at CODEX_HOME rather than ~/.codex, when its shim is there', { timeout: 120_000 }, () => {
    expect(run(() => writeShim(codexHookScriptPath()))).toEqual([...BASE, 'install --codex', ...TAIL])
  })

  it('refreshes Copilot user scope only, at COPILOT_HOME, when its shim is there', { timeout: 120_000 }, () => {
    expect(run(() => writeShim(copilotCliScriptPath()))).toEqual([...BASE, 'install --copilot', ...TAIL])
  })

  it('refreshes Copilot project scope only when the checkout carries the shim', { timeout: 120_000 }, () => {
    expect(run((root) => writeShim(copilotCliScriptPath({ local: true, projectRoot: root })))).toEqual([...BASE, 'install --copilot --local', ...TAIL])
  })

  it('refreshes every host that has a shim, in the order the install steps are listed', { timeout: 120_000 }, () => {
    const args = run((root) => {
      writeShim(codexHookScriptPath())
      writeShim(copilotCliScriptPath())
      writeShim(copilotCliScriptPath({ local: true, projectRoot: root }))
    })
    expect(args).toEqual([...BASE, 'install --copilot', 'install --copilot --local', 'install --codex', ...TAIL])
  })
})

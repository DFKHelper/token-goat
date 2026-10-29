// scripts/post-merge.mjs runs after every pull, merge and rebase, and past the build it acts on the user's real home: hook-server stop, worker restart, install, doctor --repair, prune and index. Run from a linked worktree it re-pointed every installed hook at that worktree's dist and started a worker there, so a linked worktree must stop after the build. CAPTURE: the repositories are real (`git init`, `git commit`, `git worktree add`) and the script is the shipped one, copied beside a stub bundle that only records the arguments it was run with. The same holds for a checkout that is not the active install: with the global token-goat a registry copy, a pull in the checkout started a worker and a hook server from the checkout's dist while the hooks still ran the registry copy.
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
  fs.copyFileSync(path.join(path.dirname(SCRIPT), 'atomic-write.mjs'), path.join(root, 'scripts', 'atomic-write.mjs'))
  fs.copyFileSync(path.join(path.dirname(SCRIPT), 'dependabot-body.mjs'), path.join(root, 'scripts', 'dependabot-body.mjs'))
  fs.copyFileSync(path.join(path.dirname(SCRIPT), 'git-executable.mjs'), path.join(root, 'scripts', 'git-executable.mjs'))
  fs.writeFileSync(path.join(root, 'build.mjs'), STUB_BUILD)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'stub', private: true, scripts: { build: 'node build.mjs' } }))
}

/** Fresh home, CODEX_HOME and COPILOT_HOME, all apart from each other and from the real ones, so the script's host check never sees a developer's own Codex or Copilot install. */
function isolatedHosts(): {
  home: string
  codexHome: string
  copilotHome: string
  npmPrefix: string
  npmCache: string
  localAppData: string
  xdgConfigHome: string
  xdgCacheHome: string
  tokenGoatHome: string
} {
  const base = tempDir()
  return {
    home: path.join(base, 'home'),
    codexHome: path.join(base, 'codex'),
    copilotHome: path.join(base, 'copilot'),
    npmPrefix: path.join(base, 'npm-prefix'),
    npmCache: path.join(base, 'npm-cache'),
    localAppData: path.join(base, 'local-app-data'),
    xdgConfigHome: path.join(base, 'xdg-config'),
    xdgCacheHome: path.join(base, 'xdg-cache'),
    tokenGoatHome: path.join(base, 'token-goat-home'),
  }
}

/** The environment every spawn in this file runs under, `extra` last. `npm test` injects lowercase npm_config_* variables (prefix, cache, userconfig) that npm reads alongside the uppercase key set here, so every npm_config_* spelling is dropped first and the one that decides the global root is NPM_CONFIG_PREFIX. The npm cache is pinned too: npm writes its debug log under it, which would otherwise create a directory under the isolated HOME. */
function isolatedEnv(hosts: ReturnType<typeof isolatedHosts>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.toLowerCase().startsWith('npm_config_')) delete env[key]
  // A developer's exported override would force the full sync in every test; only a test's own `extra` may set it.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'tg_post_merge_sync') delete env[key]
  return {
    ...env,
    HOME: hosts.home,
    USERPROFILE: hosts.home,
    LOCALAPPDATA: hosts.localAppData,
    XDG_DATA_HOME: hosts.localAppData,
    XDG_CONFIG_HOME: hosts.xdgConfigHome,
    XDG_CACHE_HOME: hosts.xdgCacheHome,
    TOKEN_GOAT_HOME: hosts.tokenGoatHome,
    CODEX_HOME: hosts.codexHome,
    COPILOT_HOME: hosts.copilotHome,
    NPM_CONFIG_PREFIX: hosts.npmPrefix,
    NPM_CONFIG_CACHE: hosts.npmCache,
    ...extra,
  }
}

function runPostMerge(root: string, log: string, hosts = isolatedHosts(), extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'post-merge.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: isolatedEnv(hosts, { TG_POST_MERGE_LOG: log, ...extra }),
  })
}

/** Where npm puts global packages for this prefix, as npm itself says it (`npm root -g`), under the same isolated environment the script runs in, so the fixture does not restate npm's per-platform layout and never reads the developer's own npm configuration. */
function globalRoot(hosts: ReturnType<typeof isolatedHosts>): string {
  const res = spawnSync('npm root -g', { shell: true, encoding: 'utf8', cwd: tempDir(), env: isolatedEnv(hosts) })
  expect(res.status, res.stderr).toBe(0)
  return res.stdout.trim()
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

  it('TG_POST_MERGE_SYNC=1 does not lift the linked-worktree stop, and the message says so', { timeout: 120_000 }, () => {
    const main = gitRepoWithCommit()
    const linked = path.join(tempDir(), 'linked')
    const added = spawnSync('git', ['worktree', 'add', '--detach', linked], { cwd: main, encoding: 'utf8' })
    expect(added.status, added.stderr).toBe(0)
    stageCheckout(linked)
    const log = path.join(tempDir(), 'linked.log')
    const res = runPostMerge(linked, log, isolatedHosts(), { TG_POST_MERGE_SYNC: '1' })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Linked worktree: built the bundle only.')
    expect(res.stdout).toContain('TG_POST_MERGE_SYNC=1 does not lift this stop.')
    expect(fs.existsSync(log), 'no step ran the bundle').toBe(false)
    expect(res.stdout).not.toContain('Full sync')
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

describe('post-merge sync in a checkout that is not the active install', () => {
  // CAPTURE: the global root is what `npm root -g` prints under a throwaway NPM_CONFIG_PREFIX. FORMAT-DERIVED: a registry install is a real directory named token-goat in that root and `npm install -g .` leaves a link to the checkout there, so the two are built here the way npm's documented global folder layout describes them (https://docs.npmjs.com/cli/v10/configuring-npm/folders). The stub npm in the fallback test is HAND-DERIVED from the one thing the script keys on, a non-zero exit from `npm root -g`; it says nothing about npm's wire format.
  const FULL_SYNC = ['hook-server stop', 'worker stop', 'worker start', 'install', 'doctor --repair', 'project prune', 'index']

  function stageMain(): { main: string; hosts: ReturnType<typeof isolatedHosts>; log: string; globalDir: string } {
    const main = gitRepoWithCommit()
    stageCheckout(main)
    const hosts = isolatedHosts()
    return { main, hosts, log: path.join(tempDir(), 'run.log'), globalDir: path.join(globalRoot(hosts), 'token-goat') }
  }

  function installRegistryCopy(globalDir: string): void {
    fs.mkdirSync(globalDir, { recursive: true })
    fs.writeFileSync(path.join(globalDir, 'package.json'), JSON.stringify({ name: 'token-goat', version: '2.9.31' }))
  }

  /** A directory holding an npm stub that refuses `root` (exit 1) and runs the stub build for `run build`; Windows names its CLI directly and POSIX finds its launcher on PATH. */
  function failingNpmPath(): NodeJS.ProcessEnv {
    const dir = tempDir()
    fs.mkdirSync(dir, { recursive: true })
    const stub = [
      "import { spawnSync } from 'node:child_process'",
      'const args = process.argv.slice(2)',
      "if (args[0] === 'root') {",
      "  process.stderr.write('stub npm: root refused\\n')",
      '  process.exit(1)',
      '}',
      "if (args[0] === 'run' && args[1] === 'build') process.exit(spawnSync(process.execPath, ['build.mjs'], { stdio: 'inherit' }).status ?? 1)",
      'process.exit(2)',
      '',
    ].join('\n')
    const stubPath = path.join(dir, 'npm-stub.mjs')
    fs.writeFileSync(stubPath, stub)
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
      fs.copyFileSync(stubPath, path.join(dir, 'npm-cli.js'))
      fs.writeFileSync(path.join(dir, 'npm.cmd'), `@"${process.execPath}" "%~dp0npm-stub.mjs" %*\r\n`)
    } else {
      fs.writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/npm-stub.mjs" "$@"\n`, { mode: 0o755 })
    }
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const env: NodeJS.ProcessEnv = { [pathKey]: `${dir}${path.delimiter}${process.env[pathKey] ?? ''}` }
    if (process.platform === 'win32') {
      const npmExecPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'npm_execpath') ?? 'npm_execpath'
      env[npmExecPathKey] = path.join(dir, 'npm-cli.js')
    }
    return env
  }

  it('builds and touches nothing else when the global token-goat is a registry copy elsewhere', { timeout: 120_000 }, () => {
    const { main, hosts, log, globalDir } = stageMain()
    installRegistryCopy(globalDir)
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    expect(fs.existsSync(path.join(main, 'dist', 'token-goat.mjs'))).toBe(true)
    expect(fs.existsSync(log), 'no step ran the bundle').toBe(false)
    expect(res.stdout).toContain('Build only, not the active install')
    expect(res.stdout).toContain(fs.realpathSync.native(globalDir))
    expect(res.stdout).toContain('npm install -g .')
    expect(res.stdout).toContain('TG_POST_MERGE_SYNC=1')
    expect(res.stdout).not.toContain('Synchronization complete')
    for (const dir of [hosts.home, hosts.codexHome, hosts.copilotHome, hosts.tokenGoatHome]) expect(fs.existsSync(dir), dir).toBe(false)
  })

  it('syncs as before, and says so, when the global token-goat links to this checkout, even through a second link', { timeout: 120_000 }, () => {
    const { main, hosts, log, globalDir } = stageMain()
    const alias = path.join(tempDir(), 'alias')
    fs.symlinkSync(main, alias, 'junction')
    fs.mkdirSync(path.dirname(globalDir), { recursive: true })
    fs.symlinkSync(alias, globalDir, 'junction')
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).not.toContain('not the active install')
    expect(res.stdout).toContain('Full sync: the global token-goat is this checkout')
    expect(loggedArgs(log)).toEqual(FULL_SYNC)
  })

  it('syncs as before, and says so, when no global token-goat exists to compare with', { timeout: 120_000 }, () => {
    const { main, hosts, log } = stageMain()
    const res = runPostMerge(main, log, hosts)
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Full sync: no global token-goat package under')
    expect(loggedArgs(log)).toEqual(FULL_SYNC)
  })

  it('does a full sync, naming the failure, when `npm root -g` fails', { timeout: 120_000 }, () => {
    const { main, hosts, log, globalDir } = stageMain()
    installRegistryCopy(globalDir)
    const res = runPostMerge(main, log, hosts, failingNpmPath())
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Full sync: `npm root -g` failed (exit 1)')
    expect(res.stdout).not.toContain('not the active install')
    expect(loggedArgs(log)).toEqual(FULL_SYNC)
  })

  it('TG_POST_MERGE_SYNC=1 forces the full sync past a registry copy, and says why', { timeout: 120_000 }, () => {
    const { main, hosts, log, globalDir } = stageMain()
    installRegistryCopy(globalDir)
    const res = runPostMerge(main, log, hosts, { TG_POST_MERGE_SYNC: '1' })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Full sync: TG_POST_MERGE_SYNC=1 forces it')
    expect(loggedArgs(log)).toEqual(FULL_SYNC)
  })

  it('a TG_POST_MERGE_SYNC value other than 1 does not force the sync', { timeout: 120_000 }, () => {
    const { main, hosts, log, globalDir } = stageMain()
    installRegistryCopy(globalDir)
    const res = runPostMerge(main, log, hosts, { TG_POST_MERGE_SYNC: '0' })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('Build only, not the active install')
    expect(fs.existsSync(log), 'no step ran the bundle').toBe(false)
  })
})

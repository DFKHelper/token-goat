/** The edit hook must queue the path the index keys on, not the path as the harness spelled it. It queued `normalizePath(file_path)`, which leaves a relative path relative, and the worker drains from its own working directory (the OS temp dir), so a relative entry named no file there: the drain read it as a deletion of a path no row carries, removed nothing, and the edit was never indexed. Every other producer resolves first (`enqueueDirtyPathsSafe` through `resolveIndexPath`, the Bash rewrite and git-mutation detectors against the command's directory). Why didn't a test catch this: every edit-hook test sends Claude Code's absolute `file_path`, and Claude Code sends nothing else (8,778 Edit/Write calls across 1,146 local transcripts, none relative, 2026-09-27), while the bridges whose tools take a relative path were only tested for their key renames. Provenance: FORMAT-DERIVED. pi-coding-agent 0.87.1 (npm tarball @earendil-works/pi-coding-agent, fetched 2026-09-27): dist/core/tools/edit.js and write.js declare `path` as "Path to the file to edit (relative or absolute)" / "Path to the file to write (relative or absolute)" and resolve it against the session cwd with resolveToCwd, and dist/core/agent-session.js passes the tool call's own `args` as the tool_result event's `input`. src/bridges/pi.ts forwards that `input` as `tool_input` with `path` renamed to `file_path`, beside `cwd: ctx.cwd`, and its spawn fallback runs `token-goat hook post_tool_use` under TOKEN_GOAT_HARNESS_OVERRIDE=pi in the host's own directory, which is what this test does. That directory is not always the session's: dist/main.js lets --session and --resume pick a session from another project and binds the tools to that session's cwd (SessionManager.open takes it from the session header), while the process stays where it was launched, so the hook runs here from a directory other than the payload's cwd, and a fix that resolved against the hook's own directory fails. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

function isolatedEnv(homeDir: string): NodeJS.ProcessEnv {
  return { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir }
}

function git(projectDir: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

// Searched for under the isolated home rather than rebuilt from dataDir()'s layout, so a layout change cannot turn "not found" into a silent pass.
function findDirtyQueue(dir: string): string | null {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findDirtyQueue(full)
      if (found !== null) return found
    } else if (entry.name === 'dirty.txt') return full
  }
  return null
}

describe('the edit hook on a relative file_path', () => {
  it('queues the absolute path, so the default drain indexes the edit', async () => {
    const projectDir = indexableDir()
    const homeDir = mkdtempSync(join(tmpdir(), 'tg-edit-relative-home-'))
    // A name no directory the drain could resolve it against holds, the test runner's included, so a relative entry cannot be indexed by accident.
    const fileName = `relative_edit_probe_${process.pid}_${Date.now()}.ts`
    const filePath = join(projectDir, fileName)
    writeFileSync(filePath, 'export function editProbeBefore(): number {\n  return 1\n}\n')
    git(projectDir, 'init', '-q')
    git(projectDir, 'add', '-A')
    const indexed = spawnSync(process.execPath, [BUNDLE, 'index', '.'], { cwd: projectDir, encoding: 'utf-8', env: isolatedEnv(homeDir) })
    expect(indexed.status, `indexing the fixture failed: ${indexed.stderr}`).toBe(0)
    const dbPath = findGlobalDb(homeDir) as string
    // Calibration: the file is indexed under its first content, so the new name below can only come from the edit reaching the drain.
    expect(querySymbols({ name: 'editProbeBefore' }, dbPath)).toHaveLength(1)

    writeFileSync(filePath, 'export function editProbeAfter(): number {\n  return 2\n}\n')
    const payload = {
      session_id: 'edit-relative-probe',
      tool_name: 'Edit',
      tool_input: { file_path: fileName },
      cwd: projectDir,
      tool_response: { output: `Successfully replaced text in ${fileName}.` },
    }
    // pi launched in another project and resumed this one's session: the hook inherits the launch directory, where the relative name names nothing.
    const launchDir = indexableDir()
    const hook = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
      cwd: launchDir,
      encoding: 'utf-8',
      input: JSON.stringify(payload),
      env: { ...isolatedEnv(homeDir), TOKEN_GOAT_HARNESS_OVERRIDE: 'pi' },
    })
    expect(hook.status, `the post_tool_use hook exited ${hook.status}: ${hook.stderr}`).toBe(0)

    const queueFile = findDirtyQueue(homeDir)
    expect(queueFile, 'the edit hook queued nothing').not.toBeNull()
    const queued = readFileSync(queueFile as string, 'utf8').split('\n').filter((l) => l.trim() !== '')

    // The daemon's own drain: no injected callbacks, so makeIndexer and makeRemover are the production defaults.
    drainOnce(dirname(dirname(queueFile as string)))
    await pendingEmbeddings()

    expect(querySymbols({ name: 'editProbeAfter' }, dbPath).map((s) => normalizePath(s.filePath)), 'the edit never reached the index').toEqual([normalizePath(filePath)])
    expect(querySymbols({ name: 'editProbeBefore' }, dbPath), 'the index still serves the content from before the edit').toEqual([])
    expect(queued.map((l) => normalizePath(l.trim())), 'the queue held the path as the harness spelled it').toEqual([normalizePath(filePath)])
  })
})

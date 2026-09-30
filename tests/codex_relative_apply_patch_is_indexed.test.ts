/** A Codex apply_patch names its files only inside the patch, relative to the directory Codex applied it in, and the hook payload carries that directory as `cwd`. The post-edit hook read `file_path`, which Codex never sends, so every file an apply_patch edited stayed stale in the index until something else touched it. This drives the shipping path end to end: the built bundle's `hook post_tool_use` under the codex harness, run from a directory other than the project so a path resolved against the hook process's own directory cannot pass, then the worker's `drainOnce` with its production default indexer, then a symbol lookup. PROVENANCE: FORMAT-DERIVED, codex-rs 0.159.2 (Cargo.toml workspace version). `core/src/tools/handlers/apply_patch_tests.rs` `post_tool_use_payload_uses_patch_input_and_tool_output` pins the post tool_input as `json!({ "command": patch })` with tool_name `apply_patch` and a string tool_response, and its `sample_patch()` writes a relative path (`*** Add File: hello.txt`). The envelope fields are the "Common input fields" of https://developers.openai.com/codex/hooks.md (fetched 2026-09-25), as in tests/fixtures/harness_hook_payloads.ts. File contents and symbol names are HAND-DERIVED. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, it } from 'vitest'

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

const fn = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

it('a Codex apply_patch naming two files relative to the payload cwd reaches the index for both', async () => {
  const projectDir = indexableDir()
  const homeDir = mkdtempSync(join(tmpdir(), 'tg-codex-patch-home-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'tg-codex-patch-elsewhere-'))
  const a = join(projectDir, 'cxpatch_a.ts')
  const b = join(projectDir, 'cxpatch_b.ts')
  writeFileSync(a, fn('cxpatchAlphaBefore'))
  writeFileSync(b, fn('cxpatchBetaBefore'))
  git(projectDir, 'init', '-q')
  git(projectDir, 'add', '-A')
  const indexed = spawnSync(process.execPath, [BUNDLE, 'index', '.'], { cwd: projectDir, encoding: 'utf-8', env: isolatedEnv(homeDir) })
  expect(indexed.status, `indexing the fixture failed: ${indexed.stderr}`).toBe(0)
  const dbPath = findGlobalDb(homeDir) as string
  // Calibration: both files are indexed under their first content, so the new names can only come from the edit reaching the drain.
  expect(querySymbols({ name: 'cxpatchAlphaBefore' }, dbPath)).toHaveLength(1)
  expect(querySymbols({ name: 'cxpatchBetaBefore' }, dbPath)).toHaveLength(1)

  writeFileSync(a, fn('cxpatchAlphaAfter'))
  writeFileSync(b, fn('cxpatchBetaAfter'))
  const patch = ['*** Begin Patch', '*** Update File: cxpatch_a.ts', '@@', '-export function cxpatchAlphaBefore(): number {', '+export function cxpatchAlphaAfter(): number {', '*** Update File: cxpatch_b.ts', '@@', '-export function cxpatchBetaBefore(): number {', '+export function cxpatchBetaAfter(): number {', '*** End Patch'].join('\n')
  const payload = { session_id: 'cx-patch', transcript_path: null, cwd: projectDir, model: 'gpt-5.5', turn_id: 'turn-1', permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'call-apply-patch', tool_input: { command: patch }, tool_response: 'Success. Updated files.' }
  const hook = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
    cwd: elsewhere,
    encoding: 'utf-8',
    input: JSON.stringify(payload),
    env: { ...isolatedEnv(homeDir), TOKEN_GOAT_HARNESS_OVERRIDE: 'codex' },
  })
  expect(hook.status, `the post_tool_use hook exited ${hook.status}: ${hook.stderr}`).toBe(0)
  const queueFile = findDirtyQueue(homeDir)
  expect(queueFile, 'the edit hook queued nothing').not.toBeNull()
  const queued = readFileSync(queueFile as string, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => normalizePath(l.trim()))
  expect(queued.sort()).toEqual([normalizePath(a), normalizePath(b)].sort())
  // The daemon's own drain: no injected callbacks, so makeIndexer and makeRemover are the production defaults.
  drainOnce(dirname(dirname(queueFile as string)))
  await pendingEmbeddings()
  expect(querySymbols({ name: 'cxpatchAlphaAfter' }, dbPath).map((s) => normalizePath(s.filePath))).toEqual([normalizePath(a)])
  expect(querySymbols({ name: 'cxpatchBetaAfter' }, dbPath).map((s) => normalizePath(s.filePath))).toEqual([normalizePath(b)])
  expect(querySymbols({ name: 'cxpatchAlphaBefore' }, dbPath)).toEqual([])
  expect(querySymbols({ name: 'cxpatchBetaBefore' }, dbPath)).toEqual([])
}, 60_000)

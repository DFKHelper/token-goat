/** A VS Code edit that touches several files must put every one of them in the dirty queue, and the daemon's own drain must then index each. VS Code's multi_replace_string_in_file names its files inside a `replacements[]` array and apply_patch names them inside the patch text, so neither carries the single `file_path` the post-edit handler read: both were left unmapped, and every file they edited stayed stale in the index until something else touched it. This drives the shipping path end to end: the built bundle's `hook post_tool_use` under the vscode harness, then the worker's `drainOnce` with its production default indexer, then a symbol lookup. PROVENANCE: FORMAT-DERIVED, VS Code 1.137.0. Tool names are `MultiReplaceString="multi_replace_string_in_file"` and `ApplyPatch="apply_patch"` in the ToolName enum of resources/app/extensions/copilot/dist/extension.js; inputs are the inputSchema of copilot_multiReplaceString `{explanation, replacements[{filePath, oldString, newString}]}` and copilot_applyPatch `{input, explanation}` in resources/app/extensions/copilot/package.json; the patch markers are the constants that same extension.js declares ("*** Begin Patch", "*** Update File: ", "*** Add File: ", "*** End Patch"). The PostToolUse envelope `{tool_name, tool_input, tool_response, tool_use_id}` is ChatHookService.executePostToolUseHook's in that extension.js. File contents and symbol names are HAND-DERIVED. */
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

/** Index two files, rewrite both on disk, send `toolName`/`toolInput` through the bundle's post_tool_use hook as VS Code would, drain, and return what the index then holds. */
async function editTwoFilesThrough(label: string, buildInput: (a: string, b: string) => Record<string, unknown>): Promise<{ dbPath: string; a: string; b: string; queued: string[] }> {
  const projectDir = indexableDir()
  const homeDir = mkdtempSync(join(tmpdir(), `tg-vscode-${label}-home-`))
  const a = join(projectDir, `${label}_a.ts`)
  const b = join(projectDir, `${label}_b.ts`)
  writeFileSync(a, fn(`${label}AlphaBefore`))
  writeFileSync(b, fn(`${label}BetaBefore`))
  git(projectDir, 'init', '-q')
  git(projectDir, 'add', '-A')
  const indexed = spawnSync(process.execPath, [BUNDLE, 'index', '.'], { cwd: projectDir, encoding: 'utf-8', env: isolatedEnv(homeDir) })
  expect(indexed.status, `indexing the fixture failed: ${indexed.stderr}`).toBe(0)
  const dbPath = findGlobalDb(homeDir) as string
  // Calibration: both files are indexed under their first content, so the new names can only come from the edit reaching the drain.
  expect(querySymbols({ name: `${label}AlphaBefore` }, dbPath)).toHaveLength(1)
  expect(querySymbols({ name: `${label}BetaBefore` }, dbPath)).toHaveLength(1)

  writeFileSync(a, fn(`${label}AlphaAfter`))
  writeFileSync(b, fn(`${label}BetaAfter`))
  const payload = { timestamp: '2026-09-28T00:00:00.000Z', hook_event_name: 'PostToolUse', session_id: `vs-${label}`, cwd: projectDir, tool_use_id: 'tu-e', tool_response: 'ok', ...buildInput(a, b) }
  const hook = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
    cwd: projectDir,
    encoding: 'utf-8',
    input: JSON.stringify(payload),
    env: { ...isolatedEnv(homeDir), TOKEN_GOAT_HARNESS_OVERRIDE: 'vscode' },
  })
  expect(hook.status, `the post_tool_use hook exited ${hook.status}: ${hook.stderr}`).toBe(0)
  const queueFile = findDirtyQueue(homeDir)
  expect(queueFile, 'the edit hook queued nothing').not.toBeNull()
  const queued = readFileSync(queueFile as string, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => normalizePath(l.trim()))
  // The daemon's own drain: no injected callbacks, so makeIndexer and makeRemover are the production defaults.
  drainOnce(dirname(dirname(queueFile as string)))
  await pendingEmbeddings()
  return { dbPath, a, b, queued }
}

function expectBothReindexed(label: string, r: { dbPath: string; a: string; b: string; queued: string[] }): void {
  expect(r.queued.sort()).toEqual([normalizePath(r.a), normalizePath(r.b)].sort())
  expect(querySymbols({ name: `${label}AlphaAfter` }, r.dbPath).map((s) => normalizePath(s.filePath))).toEqual([normalizePath(r.a)])
  expect(querySymbols({ name: `${label}BetaAfter` }, r.dbPath).map((s) => normalizePath(s.filePath))).toEqual([normalizePath(r.b)])
  expect(querySymbols({ name: `${label}AlphaBefore` }, r.dbPath)).toEqual([])
  expect(querySymbols({ name: `${label}BetaBefore` }, r.dbPath)).toEqual([])
}

describe('a VS Code edit spanning two files reaches the index for both', () => {
  it('multi_replace_string_in_file', async () => {
    const r = await editTwoFilesThrough('multirep', (a, b) => ({
      tool_name: 'multi_replace_string_in_file',
      tool_input: { explanation: 'rename both', replacements: [{ filePath: a, oldString: 'AlphaBefore', newString: 'AlphaAfter' }, { filePath: b, oldString: 'BetaBefore', newString: 'BetaAfter' }] },
    }))
    expectBothReindexed('multirep', r)
  }, 60_000)

  it('apply_patch', async () => {
    const r = await editTwoFilesThrough('applypatch', (a, b) => ({
      tool_name: 'apply_patch',
      tool_input: { explanation: 'rename both', input: `*** Begin Patch\n*** Update File: ${a}\n@@\n-export function applypatchAlphaBefore(): number {\n+export function applypatchAlphaAfter(): number {\n*** Update File: ${b}\n@@\n-export function applypatchBetaBefore(): number {\n+export function applypatchBetaAfter(): number {\n*** End Patch` },
    }))
    expectBothReindexed('applypatch', r)
  }, 60_000)
})

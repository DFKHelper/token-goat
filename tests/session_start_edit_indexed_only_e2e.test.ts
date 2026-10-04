/** A project nobody indexed, where the agent edited one file: the edit hook queues that file, the worker indexes it, and the project then has symbols. Session start read "has symbols" as "is indexed", so it told the agent the project was indexed and ran its drift sweep, which queued every other tracked file as "changed outside this session" when none had changed. This drives the shipping path end to end: the built bundle's `hook post_tool_use`, the worker's `drainOnce` with its production default indexer, then the built bundle's `hook session_start`, and finally `index .`, after which the indexed reminder must appear. PROVENANCE: FORMAT-DERIVED, the PostToolUse Write payload of https://code.claude.com/docs/en/hooks.md (fetched 2026-09-25), as in tests/fixtures/harness_hook_payloads.ts "Write of a .ts file". The reminder texts are CAPTURE, from `token-goat hook session_start` runs of the built bundle (tests/session_start_reconcile_note.test.ts). File contents and symbol names are HAND-DERIVED. */
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
const GENERIC = 'Run `token-goat index .` if this project is not indexed yet.'
const INDEXED = 'token-goat: this project is indexed.'

function isolatedEnv(homeDir: string): NodeJS.ProcessEnv {
  return { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode' }
}

function git(projectDir: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: projectDir, encoding: 'utf-8' })
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

function queuedPaths(queueFile: string): string[] {
  if (!existsSync(queueFile)) return []
  return readFileSync(queueFile, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => normalizePath(l.trim()))
}

function sessionStart(projectDir: string, homeDir: string): string {
  const payload = { session_id: 'ss-edit-only', transcript_path: join(projectDir, 'transcript.jsonl'), cwd: projectDir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' }
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'session_start'], { cwd: projectDir, encoding: 'utf-8', input: JSON.stringify(payload), env: isolatedEnv(homeDir) })
  expect(res.status, `the session_start hook exited ${res.status}: ${res.stderr}`).toBe(0)
  const parsed = JSON.parse(res.stdout === '' ? '{}' : res.stdout) as { hookSpecificOutput?: { additionalContext?: string } }
  return parsed.hookSpecificOutput?.additionalContext ?? ''
}

const fn = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

it('session start keeps the generic reminder and queues no drift for a project whose only symbols came from one edited file, until `index .` runs', async () => {
  const projectDir = indexableDir()
  const homeDir = mkdtempSync(join(tmpdir(), 'tg-ss-edit-only-home-'))
  const edited = join(projectDir, 'edited.ts')
  for (const name of ['edited', 'other1', 'other2', 'other3']) writeFileSync(join(projectDir, `${name}.ts`), fn(`${name}Before`))
  git(projectDir, 'init', '-q')
  git(projectDir, 'add', '-A')

  writeFileSync(edited, fn('editedAfter'))
  const payload = { session_id: 'ss-edit-only', transcript_path: join(projectDir, 'transcript.jsonl'), cwd: projectDir, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: edited, content: fn('editedAfter') }, tool_response: { filePath: edited, type: 'update' }, tool_use_id: 'toolu_01EDITONLY', duration_ms: 12 }
  const hook = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { cwd: projectDir, encoding: 'utf-8', input: JSON.stringify(payload), env: isolatedEnv(homeDir) })
  expect(hook.status, `the post_tool_use hook exited ${hook.status}: ${hook.stderr}`).toBe(0)
  const queueFile = findDirtyQueue(homeDir)
  expect(queueFile, 'the edit hook queued nothing').not.toBeNull()
  expect(queuedPaths(queueFile as string)).toEqual([normalizePath(edited)])
  // The daemon's own drain: no injected callbacks, so the indexer is the production default.
  drainOnce(dirname(dirname(queueFile as string)))
  await pendingEmbeddings()
  const dbPath = findGlobalDb(homeDir) as string
  // Calibration: the project now has symbols, which is the state the old check read as indexed.
  expect(querySymbols({ name: 'editedAfter' }, dbPath).map((s) => normalizePath(s.filePath))).toEqual([normalizePath(edited)])
  expect(querySymbols({ name: 'other1Before' }, dbPath)).toEqual([])

  const before = sessionStart(projectDir, homeDir)
  expect(before).toContain(GENERIC)
  expect(before).not.toContain(INDEXED)
  expect(before).not.toContain('changed outside this session')
  expect(before).not.toContain('reindexing')
  expect(queuedPaths(queueFile as string), 'session start queued files nobody changed').toEqual([])

  const indexed = spawnSync(process.execPath, [BUNDLE, 'index', '.'], { cwd: projectDir, encoding: 'utf-8', env: isolatedEnv(homeDir) })
  expect(indexed.status, `indexing the fixture failed: ${indexed.stderr}`).toBe(0)
  const after = sessionStart(projectDir, homeDir)
  expect(after).toContain(INDEXED)
  expect(after).not.toContain(GENERIC)
  expect(after).not.toContain('reindexing')
}, 60_000)

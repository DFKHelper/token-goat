/** An anchored project note is flagged once the worker's own reindex sees its symbol change, and only then. Drives the shipping path end to end: the built bundle sets the notes and lists them, Claude Code's post_tool_use hook queues the edit, and the daemon's default drain (no injected indexer) reindexes it, so a marker can only come from the real index moving under the note. Provenance: FORMAT-DERIVED. The post_tool_use payload carries the keys Claude Code documents for PostToolUse (session_id, tool_name, tool_input.file_path, cwd, tool_response: code.claude.com/docs/en/hooks), the same shape tests/edit_hook_queues_the_absolute_path.test.ts sends, and the session_start payload carries its documented session_id, cwd, hook_event_name and source, the shape tests/session_start_reconcile_note.test.ts captured, with the notes read from hookSpecificOutput.additionalContext. The fixture source and the expected markers are HAND-DERIVED from which function bodies the edit changes. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { querySymbols } from '../src/index_reader.js'
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

const BEFORE = [
  'export function alphaProbe(): number {\n  return 1\n}',
  'export function betaProbe(): number {\n  return 2\n}',
  'export function gammaProbe(): number {\n  return 3\n}',
].join('\n\n') + '\n'

// alphaProbe's body changes, betaProbe's does not, gammaProbe is removed.
const AFTER = [
  'export function alphaProbe(): number {\n  return 100\n}',
  'export function betaProbe(): number {\n  return 2\n}',
].join('\n\n') + '\n'

describe('an anchored project note', () => {
  it('is flagged after the default drain reindexes a change to its symbol, and not before', async () => {
    const projectDir = indexableDir()
    const homeDir = mkdtempSync(join(tmpdir(), 'tg-note-anchor-home-'))
    const env = isolatedEnv(homeDir)
    const filePath = join(projectDir, 'anchor_probe.ts')
    writeFileSync(filePath, BEFORE)
    git(projectDir, 'init', '-q')
    git(projectDir, 'add', '-A')
    const run = (...args: string[]) => spawnSync(process.execPath, [BUNDLE, ...args], { cwd: projectDir, encoding: 'utf-8', env })

    const indexed = run('index', '.')
    expect(indexed.status, `indexing the fixture failed: ${indexed.stderr}`).toBe(0)
    const dbPath = findGlobalDb(homeDir) as string
    expect(querySymbols({ name: 'gammaProbe' }, dbPath)).toHaveLength(1)

    const alpha = run('note', 'set', 'alpha-note', 'alpha returns one', '--anchor', 'anchor_probe.ts::alphaProbe')
    expect(alpha.status, alpha.stderr).toBe(0)
    expect(alpha.stdout).toContain('Anchored to anchor_probe.ts::alphaProbe')
    // No --anchor: the file::symbol named in the text anchors it.
    const beta = run('note', 'set', 'beta-note', 'beta is pinned in anchor_probe.ts::betaProbe')
    expect(beta.status, beta.stderr).toBe(0)
    expect(beta.stdout).toContain('Anchored to anchor_probe.ts::betaProbe')
    const gamma = run('note', 'set', 'gamma-note', 'gamma returns three', '--anchor', 'anchor_probe.ts::gammaProbe')
    expect(gamma.status, gamma.stderr).toBe(0)
    // An explicit anchor that names nothing is refused, and the note is not set.
    const missing = run('note', 'set', 'missing-note', 'x', '--anchor', 'anchor_probe.ts::deltaProbe')
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('deltaProbe')
    expect(run('note', 'list').stdout).not.toContain('missing-note')

    const before = run('note', 'list')
    expect(before.status, before.stderr).toBe(0)
    expect(before.stdout).toContain('alpha-note')
    expect(before.stdout, 'a note was flagged before anything changed').not.toMatch(/since note|symbol gone/)

    writeFileSync(filePath, AFTER)
    const hook = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], {
      cwd: projectDir,
      encoding: 'utf-8',
      input: JSON.stringify({ session_id: 'note-anchor-probe', tool_name: 'Edit', tool_input: { file_path: filePath }, cwd: projectDir, tool_response: { output: 'ok' } }),
      env,
    })
    expect(hook.status, `the post_tool_use hook exited ${hook.status}: ${hook.stderr}`).toBe(0)

    // Still unflagged: the index has not moved yet, and the flag follows the index, not the file.
    expect(run('note', 'list').stdout).not.toMatch(/since note/)

    const queueFile = findDirtyQueue(homeDir)
    expect(queueFile, 'the edit hook queued nothing').not.toBeNull()
    // The daemon's own drain: no injected callbacks, so the indexer is the production default.
    drainOnce(dirname(dirname(queueFile as string)))
    await pendingEmbeddings()
    expect(querySymbols({ name: 'gammaProbe' }, dbPath), 'the drain never reindexed the edit').toEqual([])

    const after = run('note', 'list').stdout
    const lineFor = (text: string, key: string): string => text.split('\n').find((l) => l.includes(key)) ?? ''
    expect(lineFor(after, 'alpha-note')).toContain('(changed since note)')
    expect(lineFor(after, 'beta-note')).not.toMatch(/since note|symbol gone/)
    expect(lineFor(after, 'gamma-note')).toContain('(anchored symbol gone)')

    const start = spawnSync(process.execPath, [BUNDLE, 'hook', 'session_start'], {
      cwd: projectDir,
      encoding: 'utf-8',
      input: JSON.stringify({ session_id: 'note-anchor-start', cwd: projectDir, hook_event_name: 'SessionStart', source: 'startup' }),
      env,
    })
    expect(start.status, start.stderr).toBe(0)
    const context = (JSON.parse(start.stdout || '{}') as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? ''
    expect(lineFor(context, 'alpha-note')).toContain('(changed since note)')
    expect(lineFor(context, 'gamma-note')).toContain('(anchored symbol gone)')
    expect(lineFor(context, 'beta-note')).toContain('beta is pinned')
    expect(lineFor(context, 'beta-note')).not.toMatch(/since note|symbol gone/)

    // stats --payloads reports only a size for the notes block, so the markers are checked by length: they add 21 + 23 characters, and the only other difference between two renderings a second apart is an age label ticking over, at most one character per note.
    const notesText = context.slice(context.indexOf('### Project notes'))
    const payloads = run('stats', '--payloads', '--json')
    expect(payloads.status, payloads.stderr).toBe(0)
    const report = JSON.parse(payloads.stdout) as { sessionStart: { name: string; chars: number }[] }
    const notesBlock = report.sessionStart.find((b) => b.name === 'project notes')
    expect(notesBlock, 'stats --payloads reported no project notes block').toBeDefined()
    expect(Math.abs((notesBlock as { chars: number }).chars - notesText.length)).toBeLessThanOrEqual(3)
  })
})

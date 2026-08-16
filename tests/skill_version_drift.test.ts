import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { recordSkillVersionSnapshot, checkSkillVersionDrift } from '../src/skill_version_drift.js'
import { getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import { VERSION } from '../src/version.js'
import { buildProgram } from '../src/cli.js'
import { buildCommandManifest, flattenCommandNames } from '../src/cli_commands.js'
import { postSkillHandler } from '../src/hooks_skill.js'
import { setSkillOutputsDirForTesting, setSkillsSourceDirForTesting } from '../src/skill_cache.js'
import type { HookEvent } from '../src/hook_registry.js'

/** Same "flat command names" shape skill_version_drift.ts derives internally, built from the
 * same public building blocks -- so a "no new commands" fixture is genuinely exhaustive
 * against whatever the CLI registers today, without depending on the module under test's own
 * private helper. */
function currentCommandNamesForTest(): string[] {
  return flattenCommandNames(buildCommandManifest(buildProgram()))
}

// Unique per test, so parallel/sequential runs never collide on the skill_version_snapshots
// primary key (session_id) or on any other test file's fixed literal session id (e.g.
// tests/hooks_session.test.ts's 'test-session').
function nonce(): string {
  return `svd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function skillPostEvent(skill: string, sessionId: string, body = 'irrelevant body'): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Skill',
    toolInput: { skill },
    sessionId,
    agentId: undefined,
    raw: { tool_response: body },
  }
}

/** Seeds a row as if `token-goat` were loaded at an older version with a smaller command set,
 * so checkSkillVersionDrift has genuine drift to detect. */
function seedOldSnapshot(sessionId: string, loadedVersion: string, loadedCommands: string[]): void {
  const db = getDb(globalDbPath())
  db.prepare(
    `INSERT INTO skill_version_snapshots (session_id, skill_name, loaded_version, loaded_commands_json, notified_at)
     VALUES (@sessionId, @skillName, @version, @commands, NULL)
     ON CONFLICT(session_id) DO UPDATE SET
       skill_name = @skillName, loaded_version = @version, loaded_commands_json = @commands, notified_at = NULL`,
  ).run({ sessionId, skillName: 'token-goat', version: loadedVersion, commands: JSON.stringify(loadedCommands) })
}

// postSkillHandler also caches the skill body via skill_cache.ts, which defaults to real
// on-disk skill cache/source directories -- sandbox both to a temp dir (same pattern as
// tests/hooks_skill.test.ts) so this file never touches real skill cache data.
const cacheDir = path.join(os.tmpdir(), `tg-skill-version-drift-cache-${process.pid}`)
const sourceDir = path.join(os.tmpdir(), `tg-skill-version-drift-source-${process.pid}`)

beforeEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(cacheDir, { recursive: true })
  await fs.mkdir(sourceDir, { recursive: true })
  setSkillOutputsDirForTesting(cacheDir)
  setSkillsSourceDirForTesting(sourceDir)
})

afterEach(() => {
  setSkillOutputsDirForTesting(null)
  setSkillsSourceDirForTesting(null)
})

describe('skill_version_drift', () => {
  describe('checkSkillVersionDrift — no-op cases', () => {
    it('returns null when no snapshot exists for the session', async () => {
      expect(await checkSkillVersionDrift(nonce())).toBeNull()
    })

    it('returns null for an empty/undefined session id', async () => {
      expect(await checkSkillVersionDrift('')).toBeNull()
      expect(await checkSkillVersionDrift(undefined)).toBeNull()
    })

    it('returns null when the snapshot version matches the running version (no drift)', async () => {
      const sessionId = nonce()
      await recordSkillVersionSnapshot(sessionId, 'token-goat')
      expect(await checkSkillVersionDrift(sessionId)).toBeNull()
    })
  })

  describe('recordSkillVersionSnapshot — scoping', () => {
    it('no-ops for a skill other than token-goat (no drift ever detected for it)', async () => {
      const sessionId = nonce()
      await recordSkillVersionSnapshot(sessionId, 'some-other-skill')
      expect(await checkSkillVersionDrift(sessionId)).toBeNull()
    })

    it('no-ops for an empty session id (never throws)', async () => {
      await expect(recordSkillVersionSnapshot('', 'token-goat')).resolves.not.toThrow()
      await expect(recordSkillVersionSnapshot(undefined, 'token-goat')).resolves.not.toThrow()
    })
  })

  describe('checkSkillVersionDrift — real drift', () => {
    it('reports specific new commands and fires only once per (re)load', async () => {
      const sessionId = nonce()
      // An empty "loaded commands" set plus an older version string means every currently
      // registered command counts as new -- deliberately the maximal-drift case, so the
      // message is guaranteed non-trivial regardless of which commands exist today.
      seedOldSnapshot(sessionId, '0.0.0-test-old', [])

      const first = await checkSkillVersionDrift(sessionId)
      expect(first).not.toBeNull()
      expect(first).toContain('upgraded v0.0.0-test-old -> v' + VERSION)
      expect(first).toContain('new command(s) available')
      expect(first).toContain('token-goat commands')

      // One-shot: the session was already notified, so a second check (same turn or a later
      // one) must not repeat it.
      const second = await checkSkillVersionDrift(sessionId)
      expect(second).toBeNull()
    })

    it('still nudges (generically) when the version differs but no new commands were added', async () => {
      const sessionId = nonce()
      // Seed with the *current* full command set but an older version string, so the diff is
      // empty even though the version itself has changed (e.g. a patch release with no new
      // commands, only fixes).
      seedOldSnapshot(sessionId, '0.0.0-test-old', currentCommandNamesForTest())

      const message = await checkSkillVersionDrift(sessionId)
      expect(message).not.toBeNull()
      expect(message).toContain('upgraded v0.0.0-test-old -> v' + VERSION)
      expect(message).toContain('token-goat commands')
    })

    it('a fresh (re)load resets the baseline and the one-shot notified flag', async () => {
      const sessionId = nonce()
      seedOldSnapshot(sessionId, '0.0.0-test-old', [])
      expect(await checkSkillVersionDrift(sessionId)).not.toBeNull()
      expect(await checkSkillVersionDrift(sessionId)).toBeNull()

      // Reloading the skill at the current version re-baselines: no more drift to report.
      await recordSkillVersionSnapshot(sessionId, 'token-goat')
      expect(await checkSkillVersionDrift(sessionId)).toBeNull()
    })
  })

  describe('postSkillHandler integration', () => {
    it('loading the token-goat skill stamps the current version as this session baseline', async () => {
      const sessionId = nonce()
      const result = await postSkillHandler(skillPostEvent('token-goat', sessionId))
      expect(result.hookType).toBe('pass')

      // No drift right after a fresh load at the real running version.
      expect(await checkSkillVersionDrift(sessionId)).toBeNull()

      const db = getDb(globalDbPath())
      const row = db
        .prepare('SELECT loaded_version FROM skill_version_snapshots WHERE session_id = ?')
        .get(sessionId) as { loaded_version: string } | undefined
      expect(row?.loaded_version).toBe(VERSION)
    })

    it('loading a different skill never creates a skill_version_snapshots row', async () => {
      const sessionId = nonce()
      await postSkillHandler(skillPostEvent('some-other-skill', sessionId))

      const db = getDb(globalDbPath())
      const row = db.prepare('SELECT 1 FROM skill_version_snapshots WHERE session_id = ?').get(sessionId)
      expect(row).toBeUndefined()
    })
  })
})

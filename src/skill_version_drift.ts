/**
 * Session-scoped nudge for token-goat's own version drift.
 *
 * The `token-goat` skill's body is a point-in-time snapshot of its command set, injected into
 * an agent's context once when the skill loads (see hooks_skill.ts's postSkillHandler). If the
 * installed CLI is upgraded with new commands *after* that load, a long-running session has no
 * other way to find out -- a skill only re-announces itself on an explicit reload. This is not
 * hypothetical: `json-outline`/`json-query` and `sqlite-schema`/`sqlite-query` were all added
 * mid-session in a real transcript that, later in that same session, needed exactly those
 * commands (to inspect large JSON caches and a SQLite migration it built by hand) and never
 * learned they existed, instead writing a series of throwaway probe scripts to answer questions
 * those commands now answer directly.
 *
 * recordSkillVersionSnapshot stamps the CLI version (and flat command-name set) active at load
 * time; checkSkillVersionDrift compares that snapshot against the live command set on each user
 * turn and, the first time they diverge, returns a one-shot nudge naming the specific new
 * commands -- then marks the session notified so it never repeats until the skill reloads.
 */

import { getDb } from './db.js'
import { globalDbPath } from './constants.js'
import { VERSION } from './version.js'
import { buildCommandManifest, flattenCommandNames } from './cli_commands.js'

// Only the `token-goat` skill's own command surface is meaningful to diff against itself --
// any other skill name is a no-op throughout this module.
const TRACKED_SKILL = 'token-goat'

const MAX_COMMANDS_SHOWN = 8

interface SnapshotRow {
  skill_name: string
  loaded_version: string
  loaded_commands_json: string
  notified_at: number | null
}

/**
 * The live command-name set, loading cli.ts only at the moment it is needed.
 *
 * This import is dynamic to keep cli.ts out of the *statically evaluated* module graph. This file
 * is reached from relay.ts via hooks_session.ts, so a static import here put the entire CLI --
 * commander, the MCP server, every graph/text/read command and every tool filter -- into
 * dist/token-goat-hook.mjs, which a hook `import()`s on nearly every tool call. That took the hook
 * bundle from 1.38 MB to 3.48 MB and its import+eval from ~29 ms to ~55 ms, paid on every hook,
 * to serve two rare call sites: a skill load and a drifted user turn. esbuild still inlines the
 * module into the same bundle, so nothing is fetched at runtime; it is only evaluated on first
 * use. Keep it dynamic -- a static import here is invisible until someone profiles a hook, which
 * is why tests/guards/hook_bundle_excludes_cli.test.ts fails the build instead.
 */
async function currentCommandNames(): Promise<string[]> {
  const { buildProgram } = await import('./cli.js')
  return flattenCommandNames(buildCommandManifest(buildProgram()))
}

/** Stamp the CLI version + flat command-name set active right now as this session's drift
 * baseline for `skillName`. Called from hooks_skill.ts's postSkillHandler on every (re)load of
 * the `token-goat` skill -- a reload resets both the baseline and the notified flag, since the
 * agent has presumably just re-read the current command set. No-op for any other skill name. */
export async function recordSkillVersionSnapshot(sessionId: string | undefined, skillName: string): Promise<void> {
  if (skillName !== TRACKED_SKILL || !sessionId) return
  try {
    const db = getDb(globalDbPath())
    const commands = JSON.stringify(await currentCommandNames())
    db.prepare(
      `INSERT INTO skill_version_snapshots (session_id, skill_name, loaded_version, loaded_commands_json, notified_at)
       VALUES (@sessionId, @skillName, @version, @commands, NULL)
       ON CONFLICT(session_id) DO UPDATE SET
         skill_name = @skillName, loaded_version = @version, loaded_commands_json = @commands, notified_at = NULL`,
    ).run({ sessionId, skillName, version: VERSION, commands })
  } catch {
    // fail-soft: a missed snapshot just means the drift check below finds nothing to compare
  }
}

/** If this session loaded the `token-goat` skill at an older CLI version than the one running
 * right now, and hasn't already been told, return a one-shot nudge naming the commands that are
 * new since that load; otherwise null. Marks the session notified so the nudge fires at most
 * once per skill load, not on every subsequent turn. Cheap in the common (no-drift) case: only
 * a version-string compare runs before the (heavier) command-manifest diff. */
export async function checkSkillVersionDrift(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null
  try {
    const db = getDb(globalDbPath())
    const row = db
      .prepare(
        `SELECT skill_name, loaded_version, loaded_commands_json, notified_at
         FROM skill_version_snapshots WHERE session_id = ?`,
      )
      .get(sessionId) as SnapshotRow | undefined
    if (!row || row.skill_name !== TRACKED_SKILL) return null
    if (row.notified_at !== null) return null
    if (row.loaded_version === VERSION) return null

    db.prepare(`UPDATE skill_version_snapshots SET notified_at = @now WHERE session_id = @sessionId`).run({
      now: Date.now() / 1000,
      sessionId,
    })

    let loadedCommands: string[] = []
    try {
      const parsed = JSON.parse(row.loaded_commands_json) as unknown
      if (Array.isArray(parsed)) loadedCommands = parsed as string[]
    } catch {
      loadedCommands = []
    }
    const loadedSet = new Set(loadedCommands)
    const newCommands = (await currentCommandNames()).filter((c) => !loadedSet.has(c))

    if (newCommands.length === 0) {
      return `[token-goat: upgraded v${row.loaded_version} -> v${VERSION} since you loaded this skill -- run \`token-goat commands\` if anything seems missing]`
    }
    const shown = newCommands.slice(0, MAX_COMMANDS_SHOWN)
    const more = newCommands.length > shown.length ? ` (+${newCommands.length - shown.length} more)` : ''
    return `[token-goat: upgraded v${row.loaded_version} -> v${VERSION} since you loaded this skill -- ${newCommands.length} new command(s) available: ${shown.join(', ')}${more}. Run \`token-goat commands\` for full details.]`
  } catch {
    return null
  }
}

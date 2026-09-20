/**
 * A recall pointer must keep resolving to the body it described.
 *
 * The Bash surface hands the model ids it can come back to later (`token-goat bash-output <id> --full`). Those ids used to be `commandHashSync(command, cwd)` alone, so every run of one command in one cwd wrote to the same blob: run 1 emitted a notice naming id X holding body A, an edit landed, run 2 overwrote X with body B, and run 1's notice -- still sitting in the transcript -- silently started resolving to text it never described. `storeBashOutputSync` now addresses the blob by `bashOutputIdSync`, which folds the output into that hash, and leaves a redirect at the command hash so the command-only lookups (cross-run delta folding in hooks_bash, `token-goat waste`) still reach the newest entry.
 *
 * Driven through the built bundle (`dist/token-goat.mjs hook post_tool_use`, then `dist/token-goat.mjs bash-output`) in separate processes rather than by calling the handler in-process: the store, the recall, and the cross-process blob resolution are the three things under test here, and only the shipping path exercises all three at once.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { commandHashSync } from '../src/bash_output_cache.js'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

// CAPTURE: the literal `additionalContext` emitted by `node dist/token-goat.mjs hook post_tool_use` for tool_name Bash, command `npm test`, tool_response `{stdout, exitCode: 1}` with a 16KB body, run 2026-09-20 against an isolated TOKEN_GOAT_HOME. Only the id varies between runs.
const NOTICE_PREFIX = '[token-goat] Tests failed. Run `token-goat bash-output '
const NOTICE_SUFFIX = ' | token-goat failures` to see just the failing blocks instead of the full output.'

// HAND-DERIVED: two distinct bodies for the same command, each comfortably past bash_compress.cache_min_bytes (512) so the store floor is never what this test is measuring. The marker line is what tells the two apart on recall.
function body(tag: string): string {
  const lines = [`RERUNPROBE ${tag} marker`]
  for (let i = 0; i < 200; i++) lines.push(`  at suite/case-${i} (${tag}) ${'x'.repeat(40)}`)
  return lines.join('\n') + '\n'
}

const ALPHA = body('alpha')
const BETA = body('beta')
const COMMAND = 'npm test'

describe('bash recall pointer survives a rerun of the same command', () => {
  let tgHome: string
  let cwd: string

  beforeAll(() => {
    tgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-recall-rerun-'))
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-recall-cwd-'))
  })

  afterAll(() => {
    for (const dir of [tgHome, cwd]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  })

  function postBash(output: string, sessionId: string): string {
    const res = runBundle(['hook', 'post_tool_use'], {
      env: tgIsolatedEnv(tgHome, { TOKEN_GOAT_HOME: tgHome }),
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd,
        tool_name: 'Bash',
        tool_input: { command: COMMAND },
        tool_response: { stdout: output, exitCode: 1 },
      }),
    })
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as { hookSpecificOutput?: { additionalContext?: string } }
    const notice = parsed.hookSpecificOutput?.additionalContext ?? ''
    expect(notice.startsWith(NOTICE_PREFIX)).toBe(true)
    expect(notice.endsWith(NOTICE_SUFFIX)).toBe(true)
    return notice.slice(NOTICE_PREFIX.length, notice.length - NOTICE_SUFFIX.length)
  }

  function recall(id: string): string {
    const res = runBundle(['bash-output', id, '--full'], {
      env: tgIsolatedEnv(tgHome, { TOKEN_GOAT_HOME: tgHome }),
    })
    expect(res.status).toBe(0)
    return res.stdout
  }

  it('keeps an earlier notice pointing at the body it described, and still resolves the command hash to the newest one', () => {
    const firstId = postBash(ALPHA, 'rerun-s1')
    // Calibration: the ordinary case. A pointer resolves to the body its own notice described.
    expect(recall(firstId)).toContain('RERUNPROBE alpha marker')

    const secondId = postBash(BETA, 'rerun-s2')
    expect(recall(secondId)).toContain('RERUNPROBE beta marker')

    // The regression: the same command in the same cwd, different output. Run 1's notice is still in the transcript, so its id must still name run 1's body.
    const firstAfterRerun = recall(firstId)
    expect(firstAfterRerun).toContain('RERUNPROBE alpha marker')
    expect(firstAfterRerun).not.toContain('RERUNPROBE beta marker')
    expect(secondId).not.toBe(firstId)

    // Calibration: the command-hash lookup the delta-folding and waste paths depend on still resolves, and resolves to the newest run.
    const commandKey = commandHashSync(COMMAND, cwd)
    expect(commandKey).not.toBe(firstId)
    expect(recall(commandKey)).toContain('RERUNPROBE beta marker')

    // The redirect is a blob in the same subdir as the entries, so it must not surface as a third, bodiless row in the user-facing history.
    const history = runBundle(['bash-history'], { env: tgIsolatedEnv(tgHome, { TOKEN_GOAT_HOME: tgHome }) })
    expect(history.status).toBe(0)
    expect(history.stdout.split('\n').filter((l) => l.includes(COMMAND))).toHaveLength(2)
  })
})

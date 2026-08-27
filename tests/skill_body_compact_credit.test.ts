/**
 * `token-goat skill-body <name> --compact` prints the pre-marker compact slice of a skill instead
 * of its full body, and recorded nothing for it.
 *
 * That is not a cosmetic omission. stats.ts registers a `skill_body:` prefix in
 * KIND_PREFIX_TO_SOURCE, and its skill_oversized_first_load entry says in so many words that the
 * pointer deny books zero bytes because "the follow-up command does" record the saving. The
 * follow-up command is this one, and it booked nothing, so the entire oversized-skill chain summed
 * to zero however often it fired -- a registered prefix with no producer anywhere, exactly the
 * shape tests/guards/every_registered_stat_kind_has_a_producer.test.ts now catches in general.
 *
 * Driven through the built bundle rather than an imported function, so the credit is proven on the
 * shipping path, and the expected byte count is measured from the fixture and the literal stdout
 * the binary produced rather than recomputed the way the code computes it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { spawnSync } from 'node:child_process'

import { BUNDLE } from './helpers/bundle.js'

const COMPACT = ['# Test Skill', '', 'Do the short thing.'].join('\n')
const FULL_TAIL = Array.from({ length: 60 }, (_, i) => `Step ${i}: a much longer explanation of the same thing.`).join('\n')
const BODY = `${COMPACT}\n<!-- COMPACT_END -->\n${FULL_TAIL}\n`

let scratch: string
let env: NodeJS.ProcessEnv

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf8', env })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-skillbody-'))
  fs.mkdirSync(path.join(scratch, '.claude', 'skills', 'tgtestskill'), { recursive: true })
  fs.writeFileSync(path.join(scratch, '.claude', 'skills', 'tgtestskill', 'SKILL.md'), BODY, 'utf-8')
  env = {
    ...process.env,
    TOKEN_GOAT_HOME: path.join(scratch, 'home'),
    LOCALAPPDATA: path.join(scratch, 'local'),
    APPDATA: path.join(scratch, 'roaming'),
    USERPROFILE: scratch,
    HOME: scratch,
  }
})

afterEach(() => {
  try {
    fs.rmSync(scratch, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe('skill-body --compact books the body-minus-slice saving it actually delivers', () => {
  it('records skill_body:compact with the bytes between the full file and the printed slice', async () => {
    const before = JSON.parse(cli(['stats', '--json']).stdout) as {
      by_kind: Record<string, { bytes_saved: number; events: number }>
    }
    expect(before.by_kind['skill_body:compact'], 'the isolated ledger must start empty').toBeUndefined()

    const r = cli(['skill-body', 'tgtestskill', '--compact'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(COMPACT)

    const after = JSON.parse(cli(['stats', '--json']).stdout) as {
      by_kind: Record<string, { bytes_saved: number; events: number }>
      by_source: Record<string, { bytes_saved: number }>
    }
    const row = after.by_kind['skill_body:compact']
    expect(row, 'skill-body --compact must appear in the ledger at all').toBeDefined()

    // Independent measurement: the fixture on disk, minus the slice the binary actually printed.
    const expectedBytes = Buffer.byteLength(BODY, 'utf-8') - Buffer.byteLength(r.stdout.replace(/\r?\n$/, ''), 'utf-8')
    expect([row!.events, row!.bytes_saved], 'the credit is the full body minus the emitted slice, booked once').toEqual([
      1,
      expectedBytes,
    ])
    expect(after.by_source['skill']?.bytes_saved, 'the skill_body: prefix must route the row to the skill source').toBe(
      expectedBytes,
    )
  }, 60000)

  it('books nothing for a full-body read, which substitutes for nothing', async () => {
    const r = cli(['skill-body', 'tgtestskill'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('<!-- COMPACT_END -->')

    const after = JSON.parse(cli(['stats', '--json']).stdout) as {
      by_kind: Record<string, unknown>
    }
    expect(after.by_kind['skill_body:compact'], 'printing the whole body saves nothing').toBeUndefined()
  }, 60000)
})

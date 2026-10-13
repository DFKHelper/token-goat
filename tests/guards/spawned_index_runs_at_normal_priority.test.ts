/** Regression: the guards that spawn the built bundle's `index` (case_rename_updates_indexed_path, empty_index_hint, utf16_source_is_decoded and seven more) ran it at the shipped below_normal priority, because cmdIndex lowers itself through applyIndexingPriority. CAPTURE, 2026-10-11, 8-core Windows host with eight spinning node processes: a one-file `index . --walk` took 33-59 s at below_normal against 2-14 s at normal, so those guards crossed the 60 s test limit for a reason unrelated to anything they assert. tests/setup/isolate-home.ts now pins TOKEN_GOAT_WORKER_PRIORITY to normal. This spawns the bundle with the env those guards hand it and reads back the priority its config resolves, which is the value applyIndexingPriority passes to os.setPriority; tests/process_priority.test.ts covers that step against the shipped default. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

describe('a bundle spawned by a test indexes at normal priority', () => {
  it('inherits TOKEN_GOAT_WORKER_PRIORITY=normal from the test setup', () => {
    expect(process.env['TOKEN_GOAT_WORKER_PRIORITY'], 'tests/setup/isolate-home.ts did not pin the indexing priority').toBe('normal')
  })

  it('resolves worker.priority to normal from that pin', () => {
    const home = mkdtempSync(join(tmpdir(), 'tg-prio-pin-'))
    const res = spawnSync(process.execPath, [BUNDLE, 'config', 'get', 'worker.priority', '--json'], {
      cwd: home,
      encoding: 'utf-8',
      env: { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home },
    })
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({ key: 'worker.priority', value: 'normal', source: 'env', envVar: 'TOKEN_GOAT_WORKER_PRIORITY' })
  })
})

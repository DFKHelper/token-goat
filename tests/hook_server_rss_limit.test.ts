import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { dataDirForHome } from '../src/constants.js'
import { markerPath, touchMarker } from '../src/hook_ipc.js'
import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'

describe('resident hook-server memory limit', () => {
  it('retires at 1 GiB RSS and releases the spawn throttle for a fresh server', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rss-limit-')))
    try {
      const rssPreload = path.join(root, 'report-high-rss.cjs')
      fs.writeFileSync(
        rssPreload,
        [
          'const memoryUsage = process.memoryUsage.bind(process)',
          'process.memoryUsage = (...args) => ({ ...memoryUsage(...args), rss: 1_073_741_824 })',
          '',
        ].join('\n'),
      )

      const dataDir = dataDirForHome(root)
      const dataRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataDir)) : path.dirname(dataDir)
      const env = tgIsolatedEnv(root, {
        LOCALAPPDATA: dataRoot,
        XDG_DATA_HOME: dataRoot,
        TOKEN_GOAT_HOME: path.join(root, 'token-goat-home'),
        TOKEN_GOAT_HOOK_SERVER: '1',
      })
      const spawnMarker = markerPath('spawn-0', dataDir)
      touchMarker('spawn-0', 'test', dataDir)
      expect(fs.existsSync(spawnMarker), 'fixture starts with a recent spawn marker').toBe(true)

      const run = spawnSync(process.execPath, ['-r', rssPreload, BUNDLE, 'hook-server', 'run', '--slot', '0'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 5_000,
      })

      expect(run.status, `over-budget server exit: ${run.error?.message ?? run.stderr}`).toBe(0)
      expect(fs.existsSync(spawnMarker), 'over-budget server releases the restart throttle').toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

import * as fs from 'node:fs'
import * as path from 'node:path'
import { compareSemver, saveCachedUpdateStatus } from '../../src/cli_upgrade.js'
import { dataDir } from '../../src/constants.js'
import { VERSION } from '../../src/version.js'

/** Seeds a fresh update check reporting `latest`, so `doctor` reads it from the cache instead of asking a registry. Without it a doctor test depends on the network and on whatever version npm serves that day: the run after a release would find an update, and step 7 of `doctor --fix` would report or attempt it. */
export function seedUpdateCheck(latest: string = VERSION): void {
  saveCachedUpdateStatus({ checkedAt: Date.now(), current: VERSION, latest, updateAvailable: compareSemver(latest, VERSION) > 0 })
}

export function clearUpdateCheck(): void {
  fs.rmSync(path.join(dataDir(), 'update_check.json'), { force: true })
}

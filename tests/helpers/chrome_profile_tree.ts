/** Chrome 155 on Windows refuses its DevTools port unless %USERPROFILE%/AppData/Local exists (observed; see tests/chrome_profile_tree.test.ts), and puppeteer then reports "The browser is already running for ..."; the screenshot tests borrow TG_REAL_USERPROFILE, which is an empty directory when the suite is launched under an isolated profile, so the tree is created here. */
import * as fs from 'node:fs'
import * as path from 'node:path'

export function ensureChromeProfileTree(userProfile: string | undefined, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32' || !userProfile) return
  fs.mkdirSync(path.join(userProfile, 'AppData', 'Local'), { recursive: true })
}

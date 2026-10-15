/** Regression: Chrome on Windows refuses its DevTools port when `<USERPROFILE>/AppData/Local` is missing, which puppeteer reports as "The browser is already running"; the screenshot tests borrow TG_REAL_USERPROFILE, which is an empty directory when the suite is launched under an isolated profile. */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ensureChromeProfileTree } from './helpers/chrome_profile_tree.js'

const made: string[] = []
function emptyProfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chrome-profile-'))
  made.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('ensureChromeProfileTree', () => {
  it('creates AppData/Local under an empty Windows profile', () => {
    const profile = emptyProfile()
    ensureChromeProfileTree(profile, 'win32')
    expect(fs.statSync(path.join(profile, 'AppData', 'Local')).isDirectory()).toBe(true)
  })

  it('leaves an existing tree and its contents alone', () => {
    const profile = emptyProfile()
    const marker = path.join(profile, 'AppData', 'Local', 'keep.txt')
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, 'kept')
    ensureChromeProfileTree(profile, 'win32')
    expect(fs.readFileSync(marker, 'utf8')).toBe('kept')
  })

  it('does nothing off Windows or without a profile', () => {
    const profile = emptyProfile()
    ensureChromeProfileTree(profile, 'linux')
    expect(fs.existsSync(path.join(profile, 'AppData'))).toBe(false)
    ensureChromeProfileTree('', 'win32')
    expect(fs.readdirSync(profile)).toEqual([])
    expect(() => ensureChromeProfileTree(undefined, 'win32')).not.toThrow()
  })
})

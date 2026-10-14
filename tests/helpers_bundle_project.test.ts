/** Pins makeBundleProject's env to the literal block the *_bundle_e2e files used to build by hand, so a migrated file spawns the bundle under exactly the isolation it had before. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { makeBundleProject } from './helpers/bundle.js'

let root: string | undefined

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('makeBundleProject', () => {
  it('builds the isolated env block and project dirs the bundle e2e files copied by hand', () => {
    const made = makeBundleProject('tg-bundle-project-test-')
    root = made.root
    const home = path.join(made.root, 'home')
    expect(made.project).toBe(path.join(made.root, 'project'))
    expect(fs.statSync(made.project).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(home, 'AppData', 'Roaming')).isDirectory()).toBe(true)
    expect(made.env).toEqual({
      ...process.env,
      TOKEN_GOAT_HOME: path.join(made.root, 'tg-home'),
      LOCALAPPDATA: path.join(made.root, 'data'),
      XDG_DATA_HOME: path.join(made.root, 'data'),
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
    })
  })
})

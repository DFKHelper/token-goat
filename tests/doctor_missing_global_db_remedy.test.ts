/** Regression: doctor's Database row said only "global.db not found at <path>" with nothing to do next. It now names the command that creates the file, worded and git-aware like the Symbols row (emptyIndexMessage). Provenance: HAND-DERIVED. The expected commands are computed from the fixture's shape (a directory with or without a .git marker), not read off the implementation; that `index` creates global.db was observed in an isolated lab run of the built bundle (absent after `install --project --no-index`, present after `index . --walk`). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkDbExists } from '../src/cli_doctor_index.js'

let dataDir: string
let root: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-db-remedy-data-'))
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-db-remedy-root-'))
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

describe('checkDbExists with no global.db', () => {
  it('names the walk index command for a folder that is not a git repo', () => {
    const r = checkDbExists(dataDir, undefined, root)
    expect(r.status).toBe('warn')
    expect(r.message).toContain(path.join(dataDir, 'global.db'))
    expect(r.message).toContain('token-goat index . --walk')
  })

  it('names the plain index command inside a git repo', () => {
    fs.mkdirSync(path.join(root, '.git'))
    const r = checkDbExists(dataDir, undefined, root)
    expect(r.message).toContain('token-goat index .')
    expect(r.message).not.toContain('--walk')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { checkSavingsReceipt, runDoctor, runDoctorAndExit } from '../src/cli_doctor.js'
import { checkNativeHooks } from '../src/cli_doctor_native.js'
import { _resetDataDirCacheForTesting, globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { clearUpdateCheck, seedUpdateCheck } from './helpers/update-check.js'

/** `doctor` is the tool a user runs when something is broken, so a damaged global.db has to reach its Database row instead of aborting the whole run on the first unguarded getDb. PROVENANCE: HAND-DERIVED. The garbage bytes are plain text that no SQLite header can match (a real header starts with "SQLite format 3"), and the expected row name and status come from checkDbExists in src/cli_doctor_index.ts. CAPTURE of the original defect, 2026-10-03, built bundle with LOCALAPPDATA pointed at a scratch dir holding this file: `doctor` printed only "token-goat: db: failed to enable WAL mode (file is not a database)" and exited 1. */
const GARBAGE = 'this is not sqlite at all, it is just text standing where a database should be. '.repeat(2)

describe('doctor with a corrupt global.db', () => {
  let home: string
  let root: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-corrupt-home-'))
    root = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-corrupt-root-'))
    vi.stubEnv('TOKEN_GOAT_HOME', home)
    vi.stubEnv('LOCALAPPDATA', home)
    vi.stubEnv('XDG_DATA_HOME', home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
    vi.stubEnv('COPILOT_HOME', path.join(home, '.copilot'))
    vi.stubEnv('TOKEN_GOAT_EMBEDDINGS_ENABLED', '0')
    _resetDataDirCacheForTesting()
    seedUpdateCheck()
    fs.mkdirSync(path.dirname(globalDbPath()), { recursive: true })
    fs.writeFileSync(globalDbPath(), GARBAGE)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeAllDbs()
    clearUpdateCheck()
    vi.unstubAllEnvs()
    _resetDataDirCacheForTesting()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('checkNativeHooks and checkSavingsReceipt degrade instead of throwing', () => {
    expect(() => checkNativeHooks(globalDbPath())).not.toThrow()
    const receipt = checkSavingsReceipt(globalDbPath())
    expect(receipt.status).toBe('warn')
    expect(receipt.message).toContain('could not read the stats database')
  })

  it('runDoctor finishes every check and reports the damaged file on the Database row', () => {
    const results = runDoctor(path.dirname(globalDbPath()), undefined, root, [])
    const database = results.find((r) => r.name === 'Database')
    expect(database?.status).toBe('fail')
    expect(database?.message).toContain('not a valid SQLite file')
    expect(database?.message).toContain('doctor --repair')
    expect(results.some((r) => r.name === 'Savings receipt')).toBe(true)
  })

  it('doctor prints the check list and returns the failure code, and --repair moves the file aside byte for byte', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
    const plain = await runDoctorAndExit({ dataDir: path.dirname(globalDbPath()), rootDir: root, processes: [] })
    expect(plain).toBe(1)
    expect(lines.join('\n')).toMatch(/\[FAIL\] Database/)
    lines.length = 0
    const repaired = await runDoctorAndExit({ dataDir: path.dirname(globalDbPath()), rootDir: root, processes: [], repair: true })
    expect(typeof repaired).toBe('number')
    expect(lines.join('\n')).toContain('Moved the malformed global.db aside')
    expect(lines.join('\n')).not.toMatch(/\[FAIL\] Database/)
    const moved = fs.readdirSync(path.dirname(globalDbPath())).filter((f) => f.startsWith('global.db.') && f.endsWith('.malformed'))
    expect(moved).toHaveLength(1)
    expect(fs.readFileSync(path.join(path.dirname(globalDbPath()), moved[0] as string), 'utf8')).toBe(GARBAGE)
  })
})

// Regression for readPersistedBashOutput (src/hooks_bash.ts): Claude Code writes a Bash
// tool_response's full output to <claude home>/projects/<slug>/<session id>/tool-results/*.txt
// once it exceeds the harness's 20,000-char inline head, but nothing read that file back --
// extractBashOutput saw only the head, so compression and the bash-output cache both silently
// dropped everything past it on any real output over ~20 KB. See memory
// project_persisted_bash_output_hook_sees_20k_head_model_sees_2kb.md for the captured payload
// shape this fixture reproduces (FORMAT-DERIVED).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { readPersistedBashOutput } from '../src/hooks_bash.js'
import { projectTranscriptsDir } from '../src/waste.js'
import { CAN_SYMLINK } from './helpers/can-symlink.js'

const SESSION_ID = 'dogfood-session-id'
const CWD = process.cwd()

let fakeHome: string
let prevHome: string | undefined
let prevUserProfile: string | undefined
let toolResultsDir: string

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-persisted-home-'))
  prevHome = process.env['HOME']
  prevUserProfile = process.env['USERPROFILE']
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  toolResultsDir = path.join(projectTranscriptsDir(CWD), SESSION_ID, 'tool-results')
  fs.mkdirSync(toolResultsDir, { recursive: true })
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevUserProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = prevUserProfile
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

describe('readPersistedBashOutput', () => {
  it('reads the full file when it sits inside this session\'s own tool-results directory', () => {
    const full = 'line\n'.repeat(10_000)
    const filePath = path.join(toolResultsDir, 'bo000n5ya.txt')
    fs.writeFileSync(filePath, full)
    const resp = { persistedOutputPath: filePath, persistedOutputSize: Buffer.byteLength(full, 'utf-8') }
    expect(readPersistedBashOutput(resp, CWD, SESSION_ID)).toBe(full)
  })

  it('rejects a path outside this session\'s tool-results directory', () => {
    const otherSessionDir = path.join(projectTranscriptsDir(CWD), 'other-session', 'tool-results')
    fs.mkdirSync(otherSessionDir, { recursive: true })
    const filePath = path.join(otherSessionDir, 'sneaky.txt')
    fs.writeFileSync(filePath, 'not this session\'s output')
    const resp = { persistedOutputPath: filePath, persistedOutputSize: 22 }
    expect(readPersistedBashOutput(resp, CWD, SESSION_ID)).toBeNull()
  })

  it('rejects a path that climbs out of the root with ..', () => {
    const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-persisted-escape-'))
    const filePath = path.join(escapeTarget, 'escaped.txt')
    fs.writeFileSync(filePath, 'escaped content')
    const climbed = path.join(toolResultsDir, '..', '..', '..', path.relative(path.parse(escapeTarget).root, filePath))
    const resp = { persistedOutputPath: climbed, persistedOutputSize: 16 }
    expect(readPersistedBashOutput(resp, CWD, SESSION_ID)).toBeNull()
    fs.rmSync(escapeTarget, { recursive: true, force: true })
  })

  it.skipIf(!CAN_SYMLINK)('rejects a symlink inside the directory that resolves outside it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-persisted-outside-'))
    const outsideFile = path.join(outside, 'real.txt')
    fs.writeFileSync(outsideFile, 'outside content')
    const link = path.join(toolResultsDir, 'link.txt')
    fs.symlinkSync(outsideFile, link, 'file')
    const resp = { persistedOutputPath: link, persistedOutputSize: 15 }
    expect(readPersistedBashOutput(resp, CWD, SESSION_ID)).toBeNull()
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('falls back to null when the persisted file does not exist on disk', () => {
    const filePath = path.join(toolResultsDir, 'missing.txt')
    const resp = { persistedOutputPath: filePath, persistedOutputSize: 100 }
    expect(readPersistedBashOutput(resp, CWD, SESSION_ID)).toBeNull()
  })

  it('falls back to null when the reported size does not sanity-match the file on disk', () => {
    const filePath = path.join(toolResultsDir, 'mismatched.txt')
    fs.writeFileSync(filePath, 'short')
    const resp = { persistedOutputPath: filePath, persistedOutputSize: 999_999 }
    expect(readPersistedBashOutput(resp, CWD, SESSION_ID)).toBeNull()
  })

  it('falls back to null when there is no persistedOutputPath at all', () => {
    expect(readPersistedBashOutput({}, CWD, SESSION_ID)).toBeNull()
  })
})

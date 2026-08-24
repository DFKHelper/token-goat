import { describe, it, expect } from 'vitest'

import {
  BRIDGE_CAPABILITY_MATRIX,
  bridgesStatusToJson,
  formatBridgesStatus,
  installVerificationNotice,
  VERIFICATION_BLURB,
  type BridgeVerification,
} from '../src/bridges_status.js'

/**
 * How strongly each bridge's claims are actually backed, and whether that reaches a reader.
 *
 * The matrix already carried a `sourceFile` naming its ground truth, and nothing read it -- which
 * is how a false capability claim on one row passed the entire suite once its neighbours were
 * tidied to agree with it. A provenance field that nothing renders would repeat exactly that, so
 * these assertions are about the rendered output and the install-time path, not about the constant.
 */
describe('bridge verification provenance', () => {
  it('states a level and its evidence for every bridge, with no row left blank', () => {
    for (const row of BRIDGE_CAPABILITY_MATRIX) {
      expect(['dogfooded', 'sourced', 'documented'], row.harness).toContain(row.verification)
      // A note short enough to be a placeholder is not evidence. Every real one names a version,
      // a file, or a document.
      expect(row.verificationNote.length, `${row.harness} note`).toBeGreaterThan(40)
    }
  })

  it('does not claim more bridges have been run than actually have', () => {
    // The count is pinned deliberately. Promoting a row to `dogfooded` is a claim that someone ran
    // it against the real binary, and it should require editing this number and saying so.
    const dogfooded = BRIDGE_CAPABILITY_MATRIX.filter((r) => r.verification === 'dogfooded')
    expect(dogfooded.map((r) => r.harness).sort()).toEqual(['claudecode', 'copilot_cli', 'grok'])
  })

  it('renders the level in the text table and the evidence beneath it', () => {
    const text = formatBridgesStatus()
    expect(text).toContain('verified')
    expect(text).toContain('## How each row was established')
    for (const row of BRIDGE_CAPABILITY_MATRIX) {
      expect(text, row.harness).toContain(`- ${row.harness} (${row.verification}):`)
    }
  })

  it('carries the level through --json instead of dropping it at the serializer', () => {
    // The serializer builds a fresh object with a fixed key list. Two shipped defects in this repo
    // came from exactly that shape: the field exists, the builder does not list it, the feature is
    // dead downstream and nothing fails.
    const json = bridgesStatusToJson()
    for (const row of json) {
      expect(row.verification, row.harness).toBeTruthy()
      expect(row.verificationNote, row.harness).toBeTruthy()
    }
  })

  it('warns at install time for a bridge that has never been run, and stays quiet for one that has', () => {
    const notice = installVerificationNotice('qwen')
    expect(notice).toContain('documented')
    expect(notice).toContain(VERIFICATION_BLURB['documented' as BridgeVerification])
    // Points at the one check that can actually tell the user what their harness sent.
    expect(notice).toContain('doctor')

    expect(installVerificationNotice('claudecode')).toBeNull()
  })

  it('returns nothing rather than throwing for a harness with no matrix row', () => {
    // `generic` and `hermes` are real HarnessName values with no bridge row; the install path must
    // not blow up on one.
    expect(installVerificationNotice('generic')).toBeNull()
  })
})

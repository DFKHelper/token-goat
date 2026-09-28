import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { installCopilotHooksFile, HOOKS_SCRIPT_FILE } from '../src/bridges/copilot_cli_install.js'
import { MANIFEST_RECOVERY_PREAMBLE } from '../src/manifest.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'
import { BUNDLE } from './helpers/bundle.js'

/** The session manifest token-goat builds when Copilot CLI compacts must reach the model on the next prompt, once. Copilot runs the preCompact hook but never reads its answer: tg-captures C7 (Copilot CLI 1.0.88) returned a marker as preCompact additionalContext and found it zero times in the wire requests, the OTel spans and the model's reply after a manual /compact. So the manifest is queued there, and it used to wait for the next tool call, which a prompt answered without tools never makes. The userPromptSubmitted answer does reach the model: tg-captures C3 found its additionalContext in all 5 runs, inside the user message as a `<system_reminder>` block Copilot adds itself.
 *
 * PROVENANCE: CAPTURE. tests/fixtures/copilot_cli_1_0_88/C7-006-preCompact.json and C7-007-userPromptSubmitted.json (from %TEMP%/tg-captures/C7/raw/006-preCompact.json and 007-userPromptSubmitted.json, the manual /compact and the prompt after it, one session) and C1a-005-postToolUse-view.json (from %TEMP%/tg-captures/C1a/raw/005-postToolUse-view.json, a view of sample.txt whose captured result is the file written here), the tool call that stands in for the next one after compaction. The session id is replaced per case so no two cases share a queue. */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function mkTemp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

/** Runs the shim the real installer wrote, the way Copilot runs it, pointed at the built bundle. */
function runShim(hooksDir: string, event: string, payload: unknown, cwd: string): Record<string, unknown> {
  const res = spawnSync(process.execPath, [path.join(hooksDir, HOOKS_SCRIPT_FILE), event, BUNDLE], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env },
  })
  expect(res.status, res.stderr).toBe(0)
  return JSON.parse(res.stdout) as Record<string, unknown>
}

function setup(): { proj: string; home: string; hooksDir: string; sid: string; capture: (name: string) => Record<string, unknown> } {
  const proj = mkTemp('tg-compact-resume-ws-')
  const home = mkTemp('tg-compact-resume-home-')
  fs.writeFileSync(path.join(proj, 'sample.txt'), 'alpha line one\nbeta line two\ngamma line three\n')
  const hooksDir = mkTemp('tg-compact-resume-hooks-')
  installCopilotHooksFile(hooksDir, 'copilot')
  const sid = `compact-resume-${Math.random().toString(36).slice(2)}`
  const capture = (name: string): Record<string, unknown> => {
    const payload = copilotCapture(name, { proj, home })
    payload['sessionId'] = sid
    return payload
  }
  return { proj, home, hooksDir, sid, capture }
}

describe('Copilot CLI compaction resume (CAPTURE C7, C3)', () => {
  it('delivers the manifest queued at preCompact on the next userPromptSubmitted, then never again', () => {
    const { proj, hooksDir, capture } = setup()
    expect(runShim(hooksDir, 'preCompact', capture('C7-006-preCompact'), proj)).toEqual({})

    const first = runShim(hooksDir, 'userPromptSubmitted', capture('C7-007-userPromptSubmitted'), proj)
    expect(Object.keys(first)).toEqual(['additionalContext'])
    const context = first['additionalContext'] as string
    expect(context.startsWith(MANIFEST_RECOVERY_PREAMBLE), context.slice(0, 300)).toBe(true)
    // The ledger section itself. Its file rows are not asserted: this workspace lives under the OS temp directory, which compact.ts's isNoisePath drops from every manifest by design.
    expect(context).toContain('## Session context')

    // One-shot: the next prompt and the next tool call both come back without it.
    expect(runShim(hooksDir, 'userPromptSubmitted', capture('C7-007-userPromptSubmitted'), proj)).toEqual({})
    const after = runShim(hooksDir, 'postToolUse', capture('C1a-005-postToolUse-view'), proj)
    expect(JSON.stringify(after)).not.toContain(MANIFEST_RECOVERY_PREAMBLE.slice(0, 40))
  })

  it('leaves a prompt with no compaction before it unanswered', () => {
    const { proj, hooksDir, capture } = setup()
    expect(runShim(hooksDir, 'userPromptSubmitted', capture('C7-007-userPromptSubmitted'), proj)).toEqual({})
  })

  it('still delivers the manifest on the next tool call when a tool call comes before the next prompt', () => {
    const { proj, hooksDir, capture } = setup()
    runShim(hooksDir, 'preCompact', capture('C7-006-preCompact'), proj)
    const post = runShim(hooksDir, 'postToolUse', capture('C1a-005-postToolUse-view'), proj)
    expect(String(post['additionalContext'] ?? '')).toContain(MANIFEST_RECOVERY_PREAMBLE)
    expect(runShim(hooksDir, 'userPromptSubmitted', capture('C7-007-userPromptSubmitted'), proj)).toEqual({})
  })
})

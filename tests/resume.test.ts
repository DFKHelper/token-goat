import { describe, expect, it } from 'vitest'
import { buildResumePacket } from '../src/resume.js'
import { storeBlob } from '../src/disk_cache.js'
import { SESSIONS_SUBDIR } from '../src/session_store.js'
import { storeBashOutput } from '../src/bash_output_cache.js'

describe('buildResumePacket', () => {
  it('returns null for an invalid (empty) session id', () => {
    const packet = buildResumePacket('')
    expect(packet).toBeNull()
  })

  it('returns null for a nonexistent session id', () => {
    const packet = buildResumePacket('nonexistent-session')
    expect(packet).toBeNull()
  })

  it('returns null for an arbitrary unknown session id', () => {
    const packet = buildResumePacket('abc123')
    expect(packet).toBeNull()
  })

  it('collapses a multi-line bash command onto one markdown list line (regression: bashEntry.command was pushed raw, so a heredoc/multi-line command\'s embedded newlines split into separate top-level lines, only the first prefixed with "- ", breaking the "## Recent bash commands" list structure the model reading the resume packet assumes)', async () => {
    const sessionId = 'sid-multiline-bash'
    const multilineCommand = "cat <<'EOF'\nfoo\nEOF"
    const id = await storeBashOutput(multilineCommand, 'foo\n', 0)
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [[multilineCommand, id]] })).toBe(true)

    const packet = buildResumePacket(sessionId)
    expect(packet).not.toBeNull()
    if (packet !== null) {
      const lines = packet.split('\n')
      const bashLines = lines.filter((l) => l.startsWith('- cat'))
      // The whole command collapses onto a single "- " line, not one line per embedded newline.
      expect(bashLines).toHaveLength(1)
      expect(lines).not.toContain('foo')
      expect(lines).not.toContain('EOF')
    }
  })
})

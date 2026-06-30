import { describe, expect, it } from 'vitest'
import { buildResumePacket } from '../src/resume.js'

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
})

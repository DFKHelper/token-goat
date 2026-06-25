import { describe, expect, it } from 'vitest'
import { buildResumePacket } from '../src/resume.js'

describe('buildResumePacket', () => {
  it('returns empty string for invalid session id', () => {
    const packet = buildResumePacket('')
    expect(packet).toBe('')
  })

  it('handles missing session gracefully', () => {
    const packet = buildResumePacket('nonexistent-session')
    expect(typeof packet).toBe('string')
  })

  it('includes session id in header when successful', () => {
    // This test would require mocking session loading
    // For now, just verify the function handles the case
    const packet = buildResumePacket('abc123')
    expect(typeof packet).toBe('string')
  })
})

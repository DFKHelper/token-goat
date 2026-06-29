// Single-command post-compact restoration packet. Emits a structured context bundle for token-goat resume <session_id>.

export const MAX_RESUME_TOKENS = 2000
export const MAX_RESUME_CHARS = MAX_RESUME_TOKENS * 4

export function buildResumePacket(_sessionId: string): string {
  // NOTE: would load session cache and build packet For now, return empty to degrade gracefully
  return ''
}

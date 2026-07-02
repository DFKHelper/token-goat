// Single-command post-compact restoration packet. Emits a structured context bundle for token-goat resume <session_id>.
import { loadBlob } from './disk_cache.js'
import { SESSIONS_SUBDIR } from './session_store.js'
import { findProject } from './project.js'
import { runGit } from './util.js'
import { getBashOutput } from './bash_output_cache.js'

export const MAX_RESUME_TOKENS = 2000
export const MAX_RESUME_CHARS = MAX_RESUME_TOKENS * 4

/** Build a recovery context packet for the given session id. Returns null if the session blob is not found. Never throws. */
export function buildResumePacket(sessionId: string): string | null {
  const blob = loadBlob(SESSIONS_SUBDIR, sessionId)
  if (blob === null || typeof blob !== 'object') return null
  const raw = blob as Record<string, unknown>
  const filesArr = Array.isArray(raw['files']) ? (raw['files'] as Array<Record<string, unknown>>) : []
  const lines: string[] = [`# Resume packet — session ${sessionId}`, '']

  const editedPaths = filesArr
    .filter((f) => f['wasEdited'] === true)
    .map((f) => (typeof f['path'] === 'string' ? f['path'] : ''))
    .filter(Boolean)
    .slice(0, 10)
  if (editedPaths.length > 0) {
    lines.push('## Edited files')
    for (const p of editedPaths) lines.push(`- ${p}`)
    lines.push('')
  }

  const topRead = [...filesArr]
    .filter((f) => f['wasEdited'] !== true)
    .sort((a, b) => (typeof b['readCount'] === 'number' ? b['readCount'] : 0) - (typeof a['readCount'] === 'number' ? a['readCount'] : 0))
    .slice(0, 8)
    .map((f) => (typeof f['path'] === 'string' ? f['path'] : ''))
    .filter(Boolean)
  if (topRead.length > 0) {
    lines.push('## Top files read')
    for (const p of topRead) lines.push(`- ${p}`)
    lines.push('')
  }

  const bashOutputs = Array.isArray(raw['bashOutputs']) ? (raw['bashOutputs'] as Array<unknown>) : []
  const recentBash = bashOutputs.slice(-2)
  if (recentBash.length > 0) {
    lines.push('## Recent bash commands')
    for (const entry of recentBash) {
      if (Array.isArray(entry) && typeof entry[1] === 'string') {
        const bashEntry = getBashOutput(entry[1])
        if (bashEntry !== null) lines.push(`- ${bashEntry.command}`)
      }
    }
    lines.push('')
  }

  try {
    const projectRoot = findProject(process.cwd())?.root ?? process.cwd()
    const result = runGit(['diff', '--stat'], { cwd: projectRoot })
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      lines.push('## Uncommitted changes (git diff --stat)')
      lines.push(result.stdout.trim())
      lines.push('')
    }
  } catch {
    // fail-soft: git not available or not a repo
  }

  const text = lines.join('\n')
  if (text.length <= MAX_RESUME_CHARS) return text
  return text.slice(0, MAX_RESUME_CHARS) + '\n... (truncated to cap)\n'
}

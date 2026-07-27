// Single-command post-compact restoration packet. Emits a structured context bundle for token-goat resume <session_id>.
import { readFile } from 'node:fs/promises'
import { loadBlob } from './disk_cache.js'
import { SESSIONS_SUBDIR } from './session_store.js'
import { resolveProjectRoot } from './project.js'
import { runGit, safeSlice } from './util.js'
import { getBashOutput } from './bash_output_cache.js'
import { listSkills, getSkillFilePath, extractChecklistSection } from './skill_cache.js'

export const MAX_RESUME_TOKENS = 2000
export const MAX_RESUME_CHARS = MAX_RESUME_TOKENS * 4

// Mirrors the Python predecessor's `_SKILL_MAX_COUNT`/`_SKILL_MAX_CHARS_EACH` (resume.py):
// how many recently-loaded skills to surface, and how many characters of each one's checklist
// section to keep before the per-skill budget forces a truncation.
const SKILL_MAX_COUNT = 3
const SKILL_MAX_CHARS_EACH = 400

/**
 * Build the `## Skills` section: for each of the most recently loaded skills this session
 * (per {@link listSkills}, already sorted newest-first), extract its checklist/DoD section
 * (via {@link extractChecklistSection}) from the skill's on-disk body -- the same source
 * `token-goat skill-body <name>` reads. Falls back to a bare pointer line when no checklist
 * section is found (an unstructured skill, or the source file is no longer readable) so the
 * skill's use this session is still visible even without extractable content, mirroring the
 * Python original's identical fallback.
 *
 * Ports resume.py's "Section 1: Skill checklists" -- dropped entirely in the TS port even
 * though every primitive it needs (listSkills, getSkillFilePath, extractChecklistSection) was
 * already implemented and unit-tested here, just never wired to this call site. Without it,
 * `token-goat resume` silently omitted every skill a session had loaded, unlike the Python
 * predecessor whose resume packet led with exactly this section.
 */
async function buildSkillsSection(sessionId: string): Promise<string[]> {
  const skills = await listSkills(sessionId)
  if (skills.length === 0) return []

  const skillLines: string[] = ['## Skills']
  for (const skill of skills.slice(0, SKILL_MAX_COUNT)) {
    let checklist: string | null = null
    try {
      const filePath = await getSkillFilePath(skill.name)
      if (filePath !== null) {
        const body = await readFile(filePath, 'utf-8')
        checklist = extractChecklistSection(body)
      }
    } catch {
      // fail-soft: unreadable skill file falls through to the pointer-only line below
      checklist = null
    }
    if (checklist !== null) {
      const trimmed =
        checklist.length > SKILL_MAX_CHARS_EACH ? checklist.slice(0, SKILL_MAX_CHARS_EACH).trimEnd() + '…' : checklist
      skillLines.push(`**${skill.name}**:`)
      skillLines.push(trimmed)
    } else {
      skillLines.push(`**${skill.name}** — \`token-goat skill-body ${skill.name} --section DoD\``)
    }
  }
  skillLines.push('')
  return skillLines
}

/** Build a recovery context packet for the given session id. Returns null if the session blob is not found. Never throws. */
export async function buildResumePacket(sessionId: string): Promise<string | null> {
  const blob = loadBlob(SESSIONS_SUBDIR, sessionId)
  if (blob === null || typeof blob !== 'object') return null
  const raw = blob as Record<string, unknown>
  const filesArr = Array.isArray(raw['files']) ? (raw['files'] as Array<Record<string, unknown>>) : []
  const lines: string[] = [`# Resume packet — session ${sessionId}`, '']

  try {
    lines.push(...(await buildSkillsSection(sessionId)))
  } catch {
    // fail-soft: skill lookup must never block the rest of the resume packet
  }

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
        // A multi-line command (heredoc, multi-line script) embeds literal newlines into
        // bashEntry.command; pushed raw, each line becomes its own top-level markdown line
        // with only the first prefixed `- `, breaking this list's structure for the model
        // reading it. Collapse to one line, same defect class as mcp_compress.ts's cellText.
        if (bashEntry !== null) lines.push(`- ${bashEntry.command.replace(/[\t\r\n]+/g, ' ')}`)
      }
    }
    lines.push('')
  }

  try {
    const projectRoot = resolveProjectRoot()
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
  return safeSlice(text, MAX_RESUME_CHARS) + '\n... (truncated to cap)\n'
}

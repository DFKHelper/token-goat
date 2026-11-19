/** Finds the SKILL.md Copilot CLI loads for a skill name, in Copilot's own project and personal skill directories. */
import { access } from 'node:fs/promises'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolve } from 'node:path'

import { copilotCliUserRoot } from './copilot_home.js'
import { copilotSkillDirectoriesEnv, skillDirectories } from './copilot_host_config.js'
import { isInsideRoot } from './path_containment.js'
import { safeSkillName } from './skill_cache.js'

function expandCopilotSkillDir(entry: string, cwd: string | null): string {
  if (entry === '~') return homedir()
  if (entry.startsWith('~/') || entry.startsWith('~\\')) return resolve(homedir(), entry.slice(2))
  if (path.isAbsolute(entry)) return resolve(entry)
  return cwd ? resolve(cwd, entry) : resolve(entry)
}

function skillNameFromFrontmatter(filePath: string): string | null {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    if (!text.startsWith('---')) return null
    const end = text.indexOf('\n---', 3)
    if (end < 0) return null
    const block = text.slice(3, end)
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('name:')) continue
      const value = line.slice(5).trim()
      if (value.length > 0) {
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          return value.slice(1, -1)
        }
        return value
      }
    }
  } catch {
    // Missing or unreadable custom skill files fail open.
  }
  return null
}

async function findCustomSkillFile(root: string, name: string): Promise<string | null> {
  const direct = resolve(root, 'SKILL.md')
  try {
    if (!isInsideRoot(direct, root)) return null
    await access(direct)
    if (skillNameFromFrontmatter(direct) === name) return direct
  } catch {
    // Continue to collection layout.
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = resolve(root, entry.name, 'SKILL.md')
    try {
      if (!isInsideRoot(candidate, root)) continue
      await access(candidate)
      if (skillNameFromFrontmatter(candidate) === name) return candidate
    } catch {
      continue
    }
  }
  return null
}

/** Resolve the SKILL.md Copilot CLI loads for `skillName`, or null. Copilot does not read Claude Code's skills directory; `copilot skill --help` on 1.0.88 lists "Project .github/skills/, .agents/skills/, or .claude/skills/" and "Personal ~/.copilot/skills/ or ~/.agents/skills/", searched here in that order (project before personal, so a repository's copy wins as it does in Copilot). The personal root honours COPILOT_HOME, where tg-captures C5's wire request says the loaded body came from. Loaded on demand by hooks_skill.ts, only on Copilot CLI, so the hook entry's eager set does not carry it. Plugin-scoped `plugin:skill` names resolve through Claude Code's plugin manifest, which Copilot does not use, so they return null here. `cwd` is the hook payload's working directory; without one only the personal directories are searched. */
export async function copilotSkillPath(skillName: string, cwd: string | null): Promise<string | null> {
  const name = safeSkillName(skillName)
  if (!name || name.includes(':')) return null
  const roots: string[] = []
  if (cwd) {
    roots.push(resolve(cwd, '.github', 'skills'), resolve(cwd, '.agents', 'skills'), resolve(cwd, '.claude', 'skills'))
  }
  const userRoot = copilotCliUserRoot()
  roots.push(resolve(userRoot, 'skills'), resolve(homedir(), '.agents', 'skills'))

  const customRoots: string[] = []
  const envDirs = copilotSkillDirectoriesEnv()
  if (envDirs !== undefined) {
    for (const entry of envDirs.split(',')) {
      if (entry.trim() !== '') customRoots.push(expandCopilotSkillDir(entry.trim(), cwd))
    }
  }
  for (const entry of skillDirectories(userRoot)) {
    customRoots.push(expandCopilotSkillDir(entry, cwd))
  }
  roots.push(...customRoots)

  for (const root of roots) {
    if (customRoots.includes(root) && path.basename(root).toLowerCase() === 'skill.md') {
      try {
        if (!isInsideRoot(root, path.dirname(root))) continue
        await access(root)
        if (skillNameFromFrontmatter(root) === name) return root
      } catch {
        // Continue to collection roots and standard roots.
      }
      continue
    }

    const custom = customRoots.includes(root)
      ? await findCustomSkillFile(root, name)
      : null
    if (custom !== null) return custom

    const diskPath = resolve(root, name, 'SKILL.md')
    try {
      if (customRoots.includes(root) && !isInsideRoot(diskPath, root)) continue
      await access(diskPath)
      return diskPath
    } catch {
      continue
    }
  }
  return null
}

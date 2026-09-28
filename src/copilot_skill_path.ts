/** Finds the SKILL.md Copilot CLI loads for a skill name, in Copilot's own project and personal skill directories. */
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { copilotCliUserRoot } from './copilot_home.js'
import { safeSkillName } from './skill_cache.js'

/** Resolve the SKILL.md Copilot CLI loads for `skillName`, or null. Copilot does not read Claude Code's skills directory; `copilot skill --help` on 1.0.88 lists "Project .github/skills/, .agents/skills/, or .claude/skills/" and "Personal ~/.copilot/skills/ or ~/.agents/skills/", searched here in that order (project before personal, so a repository's copy wins as it does in Copilot). The personal root honours COPILOT_HOME, where tg-captures C5's wire request says the loaded body came from. Loaded on demand by hooks_skill.ts, only on Copilot CLI, so the hook entry's eager set does not carry it. Plugin-scoped `plugin:skill` names resolve through Claude Code's plugin manifest, which Copilot does not use, so they return null here. `cwd` is the hook payload's working directory; without one only the personal directories are searched. */
export async function copilotSkillPath(skillName: string, cwd: string | null): Promise<string | null> {
  const name = safeSkillName(skillName)
  if (!name || name.includes(':')) return null
  const roots: string[] = []
  if (cwd) {
    roots.push(resolve(cwd, '.github', 'skills'), resolve(cwd, '.agents', 'skills'), resolve(cwd, '.claude', 'skills'))
  }
  roots.push(resolve(copilotCliUserRoot(), 'skills'), resolve(homedir(), '.agents', 'skills'))
  for (const root of roots) {
    const diskPath = resolve(root, name, 'SKILL.md')
    try {
      await access(diskPath)
      return diskPath
    } catch {
      continue
    }
  }
  return null
}

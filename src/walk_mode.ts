/**
 * Git-vs-non-git detection for the indexer's walk mode.
 *
 * Lives on its own rather than in text_commands.ts, where it started: index_health.ts needs
 * nothing from that module but this one 13-line fs-only helper, and index_health.ts is on the
 * hook path (relay -> hooks_session_start -> cli_doctor -> index_health). A static import of
 * text_commands.ts from there dragged read_commands.ts, graph_commands.ts, js-yaml and fflate
 * into the hook bundle's eager set -- 0.95 MB that V8 parses on every single hook invocation for
 * a function that only calls fs.existsSync. Same split as stdin_json.ts.
 */
import * as fs from 'fs'
import * as path from 'path'

import { findProject } from './project.js'

/** Whether `cwd` sits inside a git repository, deciding the indexer's default walk mode. */
export function detectWalkMode(cwd: string): 'git' | 'non-git' {
  const project = findProject(cwd)
  if (project?.marker === '.git') return 'git'
  // walk up to see if there's a .git folder
  let cur = cwd
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) return 'git'
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return 'non-git'
}

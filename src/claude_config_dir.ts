/**
 * Where Claude Code keeps its own per-user configuration, and nothing else.
 *
 * Its own module rather than a helper inside waste.ts (where it was born) or install.ts: every layer that touches Claude Code's config tree needs it -- the installer, the skill cache, the agent-spawn hook, the session auditor -- and routing those through the waste analyser or the installer would drag an unrelated subsystem onto hook-eager paths. `src/constants.ts`, the other plausible home, is a parser-fingerprint extraction source: editing it restamps every indexed file on every machine, which a path accessor has no business causing. `src/sessions_dir.ts` is the precedent.
 */

import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Root directory Claude Code keeps its per-user state under: `CLAUDE_CONFIG_DIR` when that is set to a non-empty value, otherwise `<homeDir>/.claude`. This is Claude Code's own resolution rather than one token-goat invented, read off the shipping `@anthropic-ai/claude-code` CLI binary, which resolves its config home as `process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')` and hangs every config path -- `skills`, `agents`, `projects`, `plugins`, `settings.json`, `CLAUDE.md` -- off that one accessor, with zero sites resolving from a bare home directory. Hardcoding `~/.claude` therefore does not merely read the wrong tree for a user who sets the variable: the installer WRITES the hooks shim, the CLAUDE.md block and the skill into a directory Claude Code never looks at, so the install silently no-ops.
 *
 * `homeDir` exists for the callers that already carried an injectable home seam (`findMemoryMd`, `buildBootstrapAudit`). It is the base for the fallback only: the environment variable outranks it, exactly as it outranks `homedir()` inside Claude Code itself.
 */
export function claudeConfigDir(homeDir: string = os.homedir()): string {
  const override = process.env['CLAUDE_CONFIG_DIR']
  if (override !== undefined && override !== '') return override
  return path.join(homeDir, '.claude')
}

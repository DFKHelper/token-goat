/** `expandSpecPath()` and `resolveSpecPath()`: `~` and Windows shell mount paths in a typed file spec, shared by every file-spec command and its MCP tool. Covers `read`, `symbol --file`, `outline`, `skeleton`, `section`, `brief`, `refs` and the graph commands. Kept apart from paths.ts on purpose: resolveIndexPath is also the key canonicalizer for hook-parsed shell words, where a quoted `"~/x"` is literal and only the hook knows whether it was quoted, and paths.ts sits in the hook entry's eager bundle, which tests/guards/dist_chunks_deduped.test.ts caps. */

import * as os from 'node:os'
import * as path from 'node:path'

import { MSYS_PATH_RE, WSL_PATH_RE, resolveIndexPath, shellMountToWindowsPath } from './paths.js'

/** The front end applied to a typed path before it is resolved against anything. A leading `~` alone or followed by a separator becomes the home directory: a quoted spec reaches the program with its tilde intact, and PowerShell never expands one for a native command. `~user` is left alone, since it names another account's home, which this process has no portable way to look up. On Windows a shell mount path (`/c/x`, `/mnt/c/x`) becomes drive-letter form via shellMountToWindowsPath; not elsewhere, because this spelling is also the one opened on disk, and on Linux `/mnt/c/x` is the real path while `c:/x` is a relative one. Separators are only rewritten when a mount path matched, so every other path keeps its spelling. */
export function expandSpecPath(p: string): string {
  const expanded = p === '~' ? os.homedir() : /^~[/\\]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p
  if (process.platform !== 'win32') return expanded
  const fwd = expanded.includes('\\') ? expanded.replace(/\\/g, '/') : expanded
  return WSL_PATH_RE.test(fwd) || MSYS_PATH_RE.test(fwd) ? shellMountToWindowsPath(fwd) : expanded
}

/** resolveIndexPath for a typed file spec: the index key for the same file {@link expandSpecPath} opens on disk. */
export function resolveSpecPath(file: string, base: string = process.cwd()): string {
  return resolveIndexPath(expandSpecPath(file), expandSpecPath(base))
}

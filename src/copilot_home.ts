/** Copilot CLI's user-scope and cache directories, in a module small enough for the hook path to import. */
import * as os from 'node:os'
import * as path from 'node:path'

/** The user-scope Copilot directory. Copilot CLI documents `COPILOT_HOME` as replacing `~/.copilot` wholesale for both hooks and instructions ("If `COPILOT_HOME` is set, create the file in `$COPILOT_HOME/hooks/`" -- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks). Ignoring it is a silent total failure rather than a degraded one: install reports success, writes a valid config to `~/.copilot`, and Copilot never reads that path, so every hook simply never fires and nothing surfaces the mismatch. Blank/whitespace is treated as unset, matching how an exported-but-empty variable behaves everywhere else. Lives in its own module so the Skill hook can resolve Copilot's skill directories without loading the installer. */
export function copilotCliUserRoot(): string {
  const override = process.env['COPILOT_HOME']
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  return path.join(os.homedir(), '.copilot')
}

/** Copilot's *cache* root, which is a different directory from its user root. copilotCliUserRoot() above resolves COPILOT_HOME / ~/.copilot, where config and session state live. The MCP tool-definition cache is not there: it sits under a separate cache root, and conflating the two would silently read an empty directory and report that no MCP servers are configured. The rule below was read directly out of the shipped Copilot 1.0.80 bundle rather than taken from documentation. The native entry point is `copilotCacheHome(platform, homedir, COPILOT_CACHE_HOME, LOCALAPPDATA, XDG_CACHE_HOME)`, and the bundle also carries a plain-JS twin of the same rule which is what this mirrors. Two details are easy to get wrong and are both taken from that twin: COPILOT_CACHE_HOME is the cache root *itself* and gets no `copilot` segment appended (the bundle joins it straight to `pkg`), whereas every platform default does append one. On win32 the fallback when LOCALAPPDATA is unset is ~/.cache, not ~/Library or an XDG path. */
export function copilotCliCacheRoot(): string {
  const override = process.env['COPILOT_CACHE_HOME']
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'copilot')
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    const base = local !== undefined && local.trim() !== '' ? local : path.join(home, '.cache')
    return path.join(base, 'copilot')
  }
  const xdg = process.env['XDG_CACHE_HOME']
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : path.join(home, '.cache')
  return path.join(base, 'copilot')
}

/** Directory holding Copilot's per-server MCP tool-definition cache files. */
export function copilotCliMcpToolsDir(): string {
  return path.join(copilotCliCacheRoot(), 'mcp-tools')
}

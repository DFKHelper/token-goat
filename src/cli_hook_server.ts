/** `token-goat hook-server`: start, inspect and stop the resident hook servers in `hook_server.ts`. */
import { CliError, out, run } from './cli.js'
import { queryServers, serverStatuses } from './hook_client.js'
import { touchMarker, type ServerStatus } from './hook_ipc.js'
import { displaySafeJson } from './paths.js'
import { formatAge } from './skill_cache.js'

export async function cmdHookServerRun(opts: { slot?: string }): Promise<void> {
  const slot = Number(opts.slot ?? '0')
  // Loaded here, not at module scope: it pulls in the whole hook graph, which only a server needs.
  const { runHookServer } = await import('./hook_server.js')
  try {
    await runHookServer(slot, (argv) => run(argv))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // Started in the background with nowhere to print, so this is the only record `doctor` can show.
    touchMarker('failed', `slot ${slot}: ${message}`)
    throw new CliError(message)
  }
}

export function formatHookServerStatus(s: ServerStatus, now: number = Date.now()): string {
  return `slot ${s.slot}: pid ${s.pid}, v${s.version}, up ${formatAge(now - s.startedAt)}, served ${s.served}, errors ${s.errors}, idle ${formatAge(now - s.lastUsedAt)}`
}

export async function cmdHookServerStatus(opts: { json?: boolean }): Promise<void> {
  const statuses = await serverStatuses()
  if (opts.json === true) {
    out(displaySafeJson(statuses))
    return
  }
  if (statuses.length === 0) {
    out('No hook server is running. The next hook call starts one.')
    return
  }
  for (const s of statuses) out(formatHookServerStatus(s))
}

export async function cmdHookServerStop(): Promise<void> {
  const stopped = await queryServers('stop')
  out(stopped.length === 0 ? 'No hook server is running.' : `Stopped ${stopped.length} hook server${stopped.length === 1 ? '' : 's'}.`)
}

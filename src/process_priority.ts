/**
 * Scheduling priority for the processes that index.
 *
 * Indexing is never the user's foreground task. It is either a detached daemon draining a dirty
 * queue with `stdio: 'ignore'`, or a bulk walk the user started and then went back to their
 * editor. Until this existed, both ran at normal priority and competed with the desktop on equal
 * terms, which on a machine with a large index is felt as the whole box stalling for as long as
 * the walk lasts.
 *
 * Lowering the priority class costs nothing when the machine is idle: the scheduler only demotes a
 * process when something else actually wants the CPU. That makes it the cheapest of the two levers
 * here -- the other being `worker.embed_threads`, which caps how wide one inference can fan out.
 * They are independent and compose: the cap bounds the ceiling, the priority decides who yields.
 */
import * as os from 'node:os'

import { loadConfig } from './config.js'

/**
 * The three names `worker.priority` accepts, mapped to Node's portable priority constants.
 *
 * Nothing above `PRIORITY_NORMAL` is reachable by any name. A config file must not be able to
 * raise a background indexer over the user's own work, and leaving the door open would mean a
 * checked-in `.token-goat.toml` could do exactly that on every machine that clones the repo.
 */
const PRIORITY_BY_NAME: Record<string, number> = {
  normal: os.constants.priority.PRIORITY_NORMAL,
  below_normal: os.constants.priority.PRIORITY_BELOW_NORMAL,
  low: os.constants.priority.PRIORITY_LOW,
}

/** The name used when the configured one is not recognized. Matches config.ts's own default. */
export const DEFAULT_PRIORITY_NAME = 'below_normal'

/**
 * Resolve a `worker.priority` name to a Node priority constant.
 *
 * An unrecognized name falls back to the default rather than to the OS default. config.ts's
 * `ENUM_FIELD_VALUES` only constrains `config set`; a hand-edited or hand-committed TOML reaches
 * `validatedStr`, which accepts any string. Mapping the unknown value to "no change" would make a
 * typo silently restore exactly the behaviour this module exists to stop, and it would do so
 * without a single error anywhere -- the failure would present as "indexing still freezes my PC",
 * which is not a report anyone traces back to a misspelled config key.
 */
export function resolveWorkerPriority(name: string | undefined): number {
  const wanted = PRIORITY_BY_NAME[name ?? '']
  return wanted ?? PRIORITY_BY_NAME[DEFAULT_PRIORITY_NAME]!
}

/**
 * Ask the OS to run this process at the configured indexing priority.
 *
 * Best-effort by design, and silent on failure. `os.setPriority` throws `EPERM` where the platform
 * or the container refuses the change (some hardened Linux configurations forbid even lowering
 * one's own niceness, and a few CI sandboxes reject it outright). A failure means indexing runs
 * exactly as it did before this module existed, which is a worse experience but a correct one, so
 * it is not worth failing an index run or writing a line the user cannot act on.
 *
 * Returns whether the change was applied, for tests and for `doctor` to report on.
 */
export function applyIndexingPriority(): boolean {
  try {
    os.setPriority(0, resolveWorkerPriority(loadConfig().worker.priority))
    return true
  } catch {
    return false
  }
}

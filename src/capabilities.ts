/**
 * A machine-readable statement of every capability token-goat has that can send data off the
 * machine or leave data on it, with its effective state and the place that state is enforced.
 *
 * This exists because "the control is present" and "the control is enforced" are different
 * claims, and only the second one is worth anything to somebody reviewing this tool before
 * letting it near their source code. A configuration file can say `offline = true`; that says
 * nothing about whether any code reads the value. So each entry below carries `enforcedAt`, a
 * file and symbol a reviewer can open, and `tests/guards/capabilities_cover_every_egress.test.ts`
 * fails the build if a module that can open a socket is not named by one of them.
 *
 * The intended use is `token-goat capabilities --json` in the reviewer's own pipeline, asserting
 * on the states they require, so the answer comes from the installed binary on their machine
 * rather than from documentation.
 */
import { loadConfig, type Config } from './config.js'

/** What a capability can do with data, which is what a reviewer is actually deciding about. */
export type CapabilityKind =
  /** Can send bytes to a host outside this machine. */
  | 'egress'
  /** Can write bytes to disk that outlive the process. */
  | 'at-rest'

export interface Capability {
  /** Stable identifier, safe to assert on in a pipeline. Never renamed without a major version. */
  readonly id: string
  readonly kind: CapabilityKind
  /** One plain sentence: what this does when it is on. */
  readonly what: string
  /** True when this capability is currently able to act. */
  readonly enabled: boolean
  /** The configuration key that decides `enabled`, in `section.key` form. */
  readonly controlledBy: string
  /**
   * Where the decision is actually made, as `file::symbol`. A reviewer can open exactly this and
   * see the check. Kept honest by the guard test named in this file's header.
   */
  readonly enforcedAt: string
}

/**
 * Every module in `src/` that can open a network socket, by design.
 *
 * The guard test derives the same set from the source tree and fails if the two disagree, so a
 * new feature that reaches the network cannot ship without being classified here first. That is
 * the difference between an inventory and a list somebody remembered to update.
 */
export const EGRESS_MODULES: readonly string[] = ['webfetch.ts', 'embed_model.ts', 'image_ocr.ts', 'screenshot.ts']

export function collectCapabilities(config: Config = loadConfig()): Capability[] {
  const online = !config.network.offline
  return [
    {
      id: 'network.http_fetch',
      kind: 'egress',
      what: 'Fetches a URL when a command asks for one, including page text and remote images.',
      enabled: online,
      controlledBy: 'network.offline',
      enforcedAt: 'src/webfetch.ts::performHttpFetch',
    },
    {
      id: 'network.google_drive',
      kind: 'egress',
      what: 'Exports a Google Doc so a section of it can be read.',
      // Two independent gates, so this reports the conjunction: turning either one off is enough.
      enabled: online && config.gdrive.enabled,
      controlledBy: 'gdrive.enabled, network.offline',
      enforcedAt: 'src/gdrive.ts::fetchDoc (network gate in src/webfetch.ts::performHttpFetch)',
    },
    {
      id: 'network.embedding_model_download',
      kind: 'egress',
      what: 'Downloads the local embedding model once, so semantic search can run without a server.',
      enabled: online,
      controlledBy: 'network.offline',
      enforcedAt: 'src/embed_model.ts',
    },
    {
      id: 'network.ocr_data_download',
      kind: 'egress',
      what: 'Downloads OCR language data once, so text can be read out of an image.',
      enabled: online,
      controlledBy: 'network.offline',
      enforcedAt: 'src/image_ocr.ts',
    },
    {
      id: 'network.screenshot',
      kind: 'egress',
      what: 'Loads a page in a browser to capture it.',
      enabled: online,
      controlledBy: 'network.offline',
      enforcedAt: 'src/screenshot.ts',
    },
    {
      id: 'at_rest.symbol_index',
      kind: 'at-rest',
      what: 'Stores the text of indexed source files in a local database, so a symbol can be returned without re-reading the file.',
      // Always on: it is the product. Reported anyway, because a reviewer deciding about data at
      // rest needs the always-on items more than the optional ones.
      enabled: true,
      controlledBy: 'always on (this is what the tool does)',
      enforcedAt: 'src/db.ts',
    },
    {
      id: 'at_rest.command_output_cache',
      kind: 'at-rest',
      what: 'Keeps recent command and web output on disk so it can be recalled instead of re-run. Expires after 24 hours.',
      enabled: true,
      controlledBy: 'always on, 24-hour expiry',
      enforcedAt: 'src/disk_cache.ts',
    },
  ]
}

/** Human-readable form of {@link collectCapabilities}, grouped so egress is read first. */
export function renderCapabilities(caps: readonly Capability[]): string {
  const lines: string[] = []
  for (const kind of ['egress', 'at-rest'] as const) {
    const group = caps.filter((c) => c.kind === kind)
    if (group.length === 0) continue
    lines.push(kind === 'egress' ? 'Can send data off this machine:' : 'Leaves data on this machine:')
    for (const c of group) {
      lines.push(`  [${c.enabled ? 'ON ' : 'OFF'}] ${c.id}`)
      lines.push(`         ${c.what}`)
      lines.push(`         controlled by: ${c.controlledBy}`)
      lines.push(`         enforced at:   ${c.enforcedAt}`)
    }
    lines.push('')
  }
  lines.push('Verify rather than trust: `token-goat capabilities --json` reports the state of the')
  lines.push('binary you have installed, and each "enforced at" names the code that decides it.')
  return lines.join('\n')
}

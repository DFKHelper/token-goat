/**
 * Windsurf's Cascade agent has no local hook-file surface: `cascadeHooksJson` is a tenant/team-settings
 * field pushed from Windsurf's own server, declared as a protobuf field on `GetCliTeamSettingsResponse`
 * (seat-management), never read from or written to a file on disk. Confirmed by tracing every occurrence
 * of `cascadeHooksJson` across the shipped Windsurf 1.110.1 install on this machine (`extensions/windsurf/
 * dist/extension.js`, `out/vs/workbench/workbench.desktop.main.js`, and the Go language server binary
 * `extensions/windsurf/bin/language_server_windows_x64.exe`): every hit is either a protobuf field
 * declaration or a class-constructor default (`this.cascadeHooksJson=""`) alongside other confirmed
 * tenant-policy fields (`cliPermissionsDeny`, `defaultModelUid`, `mcpRegistryUrls`, `enforceMcpRegistry`).
 * The same bundles' Copilot-CLI/Claude-plugin importers DO have real local hook-file readers
 * (`hookConfigPaths=["hooks.json"]`, `hookConfigPaths=["hooks/hooks.json"]`) -- a positive control proving
 * this method finds local hook wiring where it exists, so Cascade's absence of one is not a blind grep
 * returning nothing everywhere.
 *
 * The risk this guards against is not "Windsurf support is incomplete" -- it is that a future change
 * *invents* a local Cascade hook file that Windsurf silently ignores, shipping a user a config that looks
 * installed and does nothing. So this guard is a structural absence check, re-run every time this repo's
 * own source changes, independent of whether Windsurf ever grows a real local hook surface (if it does,
 * this guard's population lives in the fix commit's diff, not a place a reviewer has to remember to look).
 *
 * `windsurf` is deliberately NOT a member of `HarnessName` / `KNOWN_HARNESS_NAMES`: those identities are
 * this codebase's own convention for "a harness a bridge installer wires hooks for" (see
 * `src/bridges/registry.ts` and `src/bridges/types.ts`). Windsurf gets a passive Bash-output compression
 * filter only (`windsurfFilter` in `src/tool_filters/ai_clis.ts`), which is asserted present below as the
 * guard's own positive control: the file-scanning half of this test is proven to see real content, not an
 * empty file it never opened.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')
const SRC_DIR = path.join(REPO_ROOT, 'src')

interface SrcFile {
  readonly rel: string
  readonly code: string
}

function srcFiles(): readonly SrcFile[] {
  const out: string[] = []
  ;(function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  })(SRC_DIR)
  const pinned = pinnedPopulation({
    what: 'src/**/*.ts files scanned for a Cascade local-hook-file surface',
    items: out,
    floor: 150,
    mustInclude: [path.join('bridges', 'registry.ts'), path.join('bridges', 'types.ts'), path.join('tool_filters', 'ai_clis.ts')],
  })
  return pinned.map((p) => ({
    rel: path.relative(REPO_ROOT, p).split(path.sep).join('/'),
    code: fs.readFileSync(p, 'utf8'),
  }))
}

/** Any of these appearing in `src/` means something now believes Cascade has a local hook file to install. */
const CASCADE_HOOK_MARKERS: readonly RegExp[] = [
  /cascadeHooksJson/i,
  /cascade_hooks_json/i,
  /\.codeium[\\/]windsurf[\\/]hooks/i,
  /windsurf[\\/]hooks\.json/i,
]

describe('Windsurf: no Cascade local hook file', () => {
  const files = srcFiles()

  it('src/ never references a Cascade hook-file path or the cascadeHooksJson field name', () => {
    const hits: string[] = []
    for (const f of files) {
      for (const re of CASCADE_HOOK_MARKERS) {
        if (re.test(f.code)) hits.push(`${f.rel} matches ${re}`)
      }
    }
    expect(
      hits,
      'a source file now mentions a Cascade hook-file path or field name. cascadeHooksJson is ' +
        "server-pushed tenant/team-settings data (confirmed against the installed Windsurf binary); " +
        'there is no local file for token-goat to read or write. If Windsurf has since shipped a real ' +
        'local hook file, update this guard in the same commit that adds the installer, with fresh ' +
        'evidence cited.',
    ).toEqual([])
  })

  it("'windsurf' is not registered as a hook-installable harness identity", () => {
    const registry = fs.readFileSync(path.join(SRC_DIR, 'bridges', 'registry.ts'), 'utf8')
    const types = fs.readFileSync(path.join(SRC_DIR, 'bridges', 'types.ts'), 'utf8')
    expect(/'windsurf'/.test(registry), "KNOWN_HARNESS_NAMES must not gain a 'windsurf' entry without a real local hook surface behind it").toBe(false)
    expect(/'windsurf'/.test(types), "HarnessName must not gain a 'windsurf' member without a real local hook surface behind it").toBe(false)
  })

  it('positive control: the passive windsurf Bash-output filter is real, not an empty scan', () => {
    const filters = files.find((f) => f.rel === 'src/tool_filters/ai_clis.ts')
    expect(filters, 'src/tool_filters/ai_clis.ts must be part of the scanned population').toBeDefined()
    expect(filters!.code).toMatch(/name:\s*'windsurf'/)
    expect(filters!.code).toMatch(/binaries:\s*\[\s*'windsurf'\s*\]/)
  })
})

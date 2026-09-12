/**
 * JetBrains IDEs (WebStorm, IntelliJ, PyCharm, Rider, PhpStorm) have no local integration point for
 * token-goat today. Confirmed live on this machine (IntelliJIdea2025.2 and WebStorm2024.2 installed,
 * `%APPDATA%\JetBrains` present): there is no `~/.junie` directory anywhere on disk, and the only
 * Copilot-for-JetBrains artifact present is a theme jar (`CopilotDarkTheme.jar`) -- the real
 * Copilot-for-JetBrains agent plugin is not installed, so its hook/MCP surface cannot be driven
 * live from here.
 *
 * Per JetBrains' own docs (junie.jetbrains.com/docs/guidelines-and-memory.html and
 * junie-cli-mcp-configuration.html), Junie's ACP agent reads guidelines from `.junie/AGENTS.md` /
 * `~/.junie/AGENTS.md`, MCP servers from `~/.junie/mcp/mcp.json` / `.junie/mcp/mcp.json`
 * (`mcpServers` root), and -- per a secondary source -- hooks from `~/.junie/config.json`, where
 * "hooks from the default project configuration file are ignored". None of that was read from a
 * live Junie CLI or a real `~/.junie` directory on this machine, because neither exists here: it is
 * documentation-only, unverified against a live run, and the hooks config's on-disk shape is itself
 * unconfirmed by any source. Writing a `~/.junie/config.json` or `~/.junie/mcp/mcp.json` on the
 * strength of that alone risks shipping a file Junie ignores, misparses, or reads under a different
 * shape than assumed.
 *
 * The risk this guards against is the same one `windsurf_never_writes_cascade_hooks.test.ts` guards
 * against for Windsurf: a future change *invents* a local JetBrains/Junie config file that nothing
 * verified live, shipping a user a config that looks installed and does nothing (or, worse, one
 * Junie's actual on-disk schema rejects outright). So this guard is a structural absence check,
 * re-run every time this repo's own source changes, independent of whether JetBrains support is
 * ever built (if it is, this guard's population lives in the fix commit's diff, not a place a
 * reviewer has to remember to look, and the new installer would need its own live-verified evidence
 * before this guard is loosened).
 *
 * `junie` and `jetbrains` are deliberately NOT members of `HarnessName` / `KNOWN_HARNESS_NAMES`
 * (`src/bridges/types.ts`, `src/bridges/registry.ts`): those identities are this codebase's own
 * convention for "a harness a bridge installer wires hooks or MCP for". JetBrains gets nothing yet,
 * not even a passive Bash-output filter (`src/tool_filters/ai_clis.ts`) -- it is a GUI IDE with no
 * CLI binary to spawn, unlike Windsurf/Cursor/Cline, which is why this guard's positive control
 * (below) instead asserts that the scanned `registry.ts` content is real, non-empty source
 * containing the harnesses that ARE registered -- proving the scan sees real file content, not an
 * empty read.
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
    what: 'src/**/*.ts files scanned for a JetBrains/Junie local-config-file surface',
    items: out,
    floor: 150,
    mustInclude: [path.join('bridges', 'registry.ts'), path.join('bridges', 'types.ts')],
  })
  return pinned.map((p) => ({
    rel: path.relative(REPO_ROOT, p).split(path.sep).join('/'),
    code: fs.readFileSync(p, 'utf8'),
  }))
}

/** Any of these appearing in `src/` means something now believes it can write a real JetBrains/Junie config file. */
const JETBRAINS_CONFIG_MARKERS: readonly RegExp[] = [
  /\.junie[\\/]config\.json/i,
  /\.junie[\\/]mcp[\\/]mcp\.json/i,
  /\.junie[\\/]AGENTS\.md/i,
  /junieConfigPath/i,
  /junieMcpPath/i,
]

describe('JetBrains: no live-verified Junie/JetBrains config file', () => {
  const files = srcFiles()

  it('src/ never references a Junie config-file path or a junie*Path helper name', () => {
    const hits: string[] = []
    for (const f of files) {
      for (const re of JETBRAINS_CONFIG_MARKERS) {
        if (re.test(f.code)) hits.push(`${f.rel} matches ${re}`)
      }
    }
    expect(
      hits,
      'a source file now references a Junie/JetBrains config-file path or helper name. Per this guard\'s ' +
        'header, ~/.junie does not exist on the machine this was verified against and no real Junie CLI or ' +
        'Copilot-for-JetBrains plugin was live-driven, so the on-disk shape is documentation-only and ' +
        'unconfirmed. If JetBrains support is added, update this guard in the same commit, with fresh ' +
        'live-captured evidence cited (not documentation alone).',
    ).toEqual([])
  })

  it("'junie' and 'jetbrains' are not registered as hook-installable harness identities", () => {
    const registry = fs.readFileSync(path.join(SRC_DIR, 'bridges', 'registry.ts'), 'utf8')
    const types = fs.readFileSync(path.join(SRC_DIR, 'bridges', 'types.ts'), 'utf8')
    for (const name of ['junie', 'jetbrains']) {
      expect(new RegExp(`'${name}'`).test(registry), `KNOWN_HARNESS_NAMES must not gain a '${name}' entry without live-verified evidence`).toBe(false)
      expect(new RegExp(`'${name}'`).test(types), `HarnessName must not gain a '${name}' member without live-verified evidence`).toBe(false)
    }
  })

  it('positive control: the scan sees real, non-empty registry source, not an empty read', () => {
    const registry = files.find((f) => f.rel === 'src/bridges/registry.ts')
    expect(registry, 'src/bridges/registry.ts must be part of the scanned population').toBeDefined()
    expect(registry!.code).toMatch(/KNOWN_HARNESS_NAMES = new Set/)
    expect(registry!.code).toMatch(/'claudecode'/)
  })
})

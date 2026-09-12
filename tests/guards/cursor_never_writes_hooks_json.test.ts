/**
 * Cursor 3.19.7's `~/.cursor/hooks.json` (and `.cursor/hooks.json` project-scoped) is a real, live
 * local hook file -- not the Zed-style total absence `windsurf_never_writes_cascade_hooks.test.ts`
 * guards. On this machine it is 6257 bytes, already owned and maintained by a third-party tool
 * (Orca), registering 8 events against `C:\Users\zelys\.orca\agent-hooks\cursor-hook.cmd`. token-goat
 * deliberately never writes to it, for two reasons documented in full in
 * `src/bridges/cursor_install.ts`'s header:
 *
 * 1. Cursor imports Claude Code's `~/.claude/settings.json` hooks by default (confirmed against the
 *    installed 3.19.7 `workbench.desktop.main.js`: `isClaudeCodeHooksEnabled` defaults to `true`),
 *    deduping only on an exact, untransformed command-string match. A second, independently written
 *    copy in `hooks.json` is pure double-fire risk the moment the two producers' command text ever
 *    diverges by so much as a flag.
 * 2. The file may be -- and here is -- owned by a third party. A naive merge risks destroying real
 *    user configuration.
 *
 * This guard is a structural absence check, re-run every time this repo's own source changes,
 * independent of whether a future change decides Cursor hooks are worth the risk (if it does, this
 * guard's population lives in the fix commit's diff, not a place a reviewer has to remember to look).
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

/**
 * Strips `/* ... *\/` and `// ...` comments before the marker scan below runs, so this guard's own
 * documentation -- and `cursor_install.ts`'s header, which necessarily *names* the path it refuses to
 * write, to explain why -- does not trip the very check meant to catch a real, executable reference.
 * Comment-stripping is intentionally naive (no string-literal awareness), same tradeoff every other
 * regex-based guard in this directory makes; it is applied only to reduce false positives, never to
 * hide a real hit, since a live `path.join(..., '.cursor', 'hooks.json')` call is code, not a comment.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
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
    what: 'src/**/*.ts files scanned for a Cursor hooks.json write surface',
    items: out,
    floor: 150,
    mustInclude: [path.join('bridges', 'cursor_install.ts'), path.join('bridges', 'zed_install.ts')],
  })
  return pinned.map((p) => ({
    rel: path.relative(REPO_ROOT, p).split(path.sep).join('/'),
    code: stripComments(fs.readFileSync(p, 'utf8')),
  }))
}

/** Any of these appearing in `src/` means something now believes token-goat should write Cursor's own hooks.json. */
const CURSOR_HOOKS_JSON_MARKERS: readonly RegExp[] = [/\.cursor[\\/]hooks\.json/i, /cursorHooksPath/i, /cursorHooksJson/i]

describe('Cursor: never writes hooks.json', () => {
  const files = srcFiles()

  it('src/ never references a Cursor hooks.json path or a Cursor-hooks helper name', () => {
    const hits: string[] = []
    for (const f of files) {
      for (const re of CURSOR_HOOKS_JSON_MARKERS) {
        if (re.test(f.code)) hits.push(`${f.rel} matches ${re}`)
      }
    }
    expect(
      hits,
      'a source file now references a Cursor hooks.json path. Cursor already imports Claude Code hooks ' +
        'from ~/.claude/settings.json by default (confirmed against the installed bundle), and ' +
        '~/.cursor/hooks.json may be a real file owned by a third party. If a future change decides the ' +
        'risk is worth it, update this guard in the same commit, with fresh evidence cited.',
    ).toEqual([])
  })

  it('positive control: src/bridges/cursor_install.ts is real and writes mcp.json, not hooks.json', () => {
    const cursorInstall = files.find((f) => f.rel === 'src/bridges/cursor_install.ts')
    expect(cursorInstall, 'src/bridges/cursor_install.ts must be part of the scanned population').toBeDefined()
    expect(cursorInstall!.code).toMatch(/'mcp\.json'/)
    expect(cursorInstall!.code).toMatch(/mcpServers/)
  })
})

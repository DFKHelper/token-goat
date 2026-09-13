/**
 * Every file the installer writes, modifies, or appends to must get a timestamped backup via
 * `backupFile` (the same mechanism `writeJsonSettings` already used for `settings.json`) before
 * this session -- `upsertDelimitedBlock`/`stripDelimitedBlock` did not (fixed in `src/util.ts`, see
 * `tests/util.test.ts`), and neither did the direct `atomicWriteText`/`writeFileSync`/
 * `writeIfDifferent` merge-writers in `src/bridges/cursor_install.ts`, `visualstudio_install.ts`,
 * `vscode_install.ts`, and `zed_install.ts` (their `mcp.json`/`settings.json` writers), nor
 * `src/install.ts`'s `installSkill` (`SKILL.md`) nor `src/bridges/kimi_install.ts`'s skill writer.
 *
 * Real incident this guards: `~/.claude/CLAUDE.md`, a user's own hand-maintained file, was silently
 * rewritten by `install`/`uninstall` with no recovery copy. At scale (hundreds of developers each
 * running `token-goat install`) that is not one recoverable mistake, it is unrecoverable data loss
 * repeated at every seat. "No exceptions, no per-file allowlist of important files" is the standing
 * rule this guard enforces: every write site in the installer is enumerated, and any new site that
 * writes to an existing file without going through a backup path fails on arrival, rather than
 * quietly joining an unbacked set someone has to notice by hand.
 *
 * This is a structural guard (source text only, no I/O beyond reading this repo's own files) with a
 * pinned, non-empty population. Three ways a write site is judged "backed up":
 *  1. It calls `writeJsonSettings` -- that helper always calls `backupFile` first (`src/util.ts`).
 *  2. It calls `upsertDelimitedBlock`/`stripDelimitedBlock` -- both call `backupFile` first, or (for
 *     `stripDelimitedBlock`) `backupFile` immediately before the final write (`src/util.ts`).
 *  3. A `backupFile(...)` call, or a `writeIfDifferent(..., true)` call (its optional third
 *     argument, literally `true`), textually precedes it inside the same enclosing function body.
 * A write site not backed up by one of those three is a real gap unless it is named in `EXEMPT`
 * with a reason a reviewer can check independently of this guard's own author.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')

/** Every file this guard scans for installer write sites. FORMAT-DERIVED: every module under `src/bridges/` whose name ends `_install.ts`, plus `src/install.ts` (the Claude Code base installer) and `src/bridges/created_configs.ts` (the shared creation/backup ledger, which writes its own ledger file). */
const TARGET_FILES = [
  'src/install.ts',
  'src/bridges/created_configs.ts',
  ...fs
    .readdirSync(path.join(REPO_ROOT, 'src', 'bridges'))
    .filter((f) => f.endsWith('_install.ts'))
    .map((f) => `src/bridges/${f}`),
] as const

/** Strips comments, same naive-but-safe tradeoff every other regex/text guard in this directory makes. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** Every `function`/`async function` declaration's brace-balanced body in `code`, as `{ name, body, start, end }`. Module-scope text outside any function is not returned -- every write site found by this guard so far lives inside a named function. */
function functionBodies(code: string): Array<{ name: string; body: string; start: number; end: number }> {
  const out: Array<{ name: string; body: string; start: number; end: number }> = []
  const declRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = declRe.exec(code)) !== null) {
    const name = m[1]!
    let i = code.indexOf('(', m.index)
    let depth = 0
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    const openBrace = code.indexOf('{', i)
    if (openBrace === -1) continue
    let d = 0
    let j = openBrace
    for (; j < code.length; j++) {
      if (code[j] === '{') d++
      else if (code[j] === '}') {
        d--
        if (d === 0) break
      }
    }
    out.push({ name, body: code.slice(openBrace, j + 1), start: openBrace, end: j + 1 })
  }
  return out
}

const WRITE_CALL_RE = /\b(atomicWriteText|writeFileSync|writeIfDifferent|writeJsonSettings|upsertDelimitedBlock|stripDelimitedBlock)\s*\(/g

interface WriteSite {
  readonly file: string
  readonly fn: string
  readonly call: string
  readonly covered: boolean
}

/**
 * Sites this guard would otherwise flag, each with a reason a reviewer can check independently:
 * exactly the "no silent allowlist" rule the task calls for -- an exemption here is a named,
 * inspectable decision, not a gap nobody had to justify.
 *
 *  - Generated shim/plugin scripts: pure invocation wrappers (`@echo off` + a `node ... mcp-serve`
 *    command line, or an equivalent fixed script constant) regenerated byte-for-byte from the
 *    current build on every install. Nothing user-authored is ever in them, so a backup protects no
 *    content a re-run could not reproduce identically.
 *  - Internal bookkeeping files: the created-configs/backups ledger itself and the Copilot-CLI
 *    hooks-owners file are token-goat's own state, never hand-edited by a user, and read only by
 *    token-goat. `created_configs.ts`'s own backupFile call (inside `writeLedger`, which is not one
 *    of these sites since it is not itself an installer write) would be circular for the ledger to
 *    back up itself.
 *  - `vscode_install.ts`'s frontmatter write only ever fires when the target file does not exist
 *    yet (guarded by `!fs.existsSync(filePath)` immediately above it) -- there is nothing on disk
 *    to lose, and `backupFile` itself no-ops on a missing path for the same reason.
 */
const EXEMPT: ReadonlyArray<{ file: string; fn: string; call: string; reason: string }> = [
  { file: 'src/install.ts', fn: 'installHooksScoped', call: "writeIfDifferent(scriptPath, CLAUDECODE_HOOK_SCRIPT)", reason: 'generated hook shim script, byte-identical on every rebuild; nothing user-authored to lose' },
  { file: 'src/bridges/codex_install.ts', fn: 'installCodex', call: 'atomicWriteText(scriptPath, CODEX_HOOK_SCRIPT)', reason: 'generated hook shim script, same class as installHooks above' },
  { file: 'src/bridges/copilot_cli_install.ts', fn: 'installCopilotHooksFile', call: 'writeIfDifferent(scriptPath, COPILOT_CLI_HOOK_SCRIPT)', reason: 'generated hook shim script, same class as installHooks above' },
  { file: 'src/bridges/copilot_cli_install.ts', fn: 'installCopilotHooksFile', call: "writeIfDifferent(copilotHooksOwnersPath(hooksDir), [...owners].sort().join('\\n') + '\\n')", reason: 'internal bookkeeping: records which harnesses share the hooks file, never hand-edited or read by anything but token-goat' },
  { file: 'src/bridges/copilot_cli_install.ts', fn: 'releaseCopilotHooksFile', call: "writeIfDifferent(ownersPath, [...owners].sort().join('\\n') + '\\n')", reason: 'same owners-file bookkeeping as installCopilotHooksFile above' },
  { file: 'src/bridges/grok_install.ts', fn: 'installGrok', call: 'writeIfDifferent(scriptPath, GROK_HOOK_SCRIPT)', reason: 'generated hook shim script, same class as installHooks above' },
  { file: 'src/bridges/kimi_install.ts', fn: 'installKimi', call: 'atomicWriteText(scriptPath, KIMI_HOOK_SCRIPT)', reason: 'generated hook shim script, same class as installHooks above' },
  { file: 'src/bridges/openclaw_install.ts', fn: 'installOpenclaw', call: 'atomicWriteText(openclawEntrySidecarPath(), JSON.stringify({ entryPath }))', reason: 'internal bookkeeping sidecar pointing at the launching entry point, never hand-edited or read by anything but token-goat' },
  { file: 'src/bridges/openclaw_install.ts', fn: 'installOpenclaw', call: 'atomicWriteText(pluginPath, OPENCLAW_PLUGIN_SCRIPT)', reason: 'generated plugin script, same class as installHooks above' },
  { file: 'src/bridges/vscode_install.ts', fn: 'writeGuidance', call: 'atomicWriteText(filePath, USER_INSTRUCTIONS_FRONTMATTER)', reason: 'only reached when !fs.existsSync(filePath) immediately above it -- nothing exists yet to lose, and backupFile itself no-ops on a missing path' },
  { file: 'src/bridges/zed_install.ts', fn: 'installZed', call: 'writeIfDifferent(shimPath, buildShimScript())', reason: 'generated hook shim script, same class as installHooks above' },
  { file: 'src/bridges/created_configs.ts', fn: 'writeLedger', call: 'atomicWriteText(ledgerPath(), `${JSON.stringify(entries)}\\n`)', reason: "token-goat's own created-configs/backups ledger; backing up the ledger with the mechanism the ledger itself powers would be circular, and nothing in it is user-authored" },
]

function scan(): WriteSite[] {
  const sites: WriteSite[] = []
  for (const relPath of TARGET_FILES) {
    const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'))
    for (const fn of functionBodies(code)) {
      let m: RegExpExecArray | null
      WRITE_CALL_RE.lastIndex = 0
      while ((m = WRITE_CALL_RE.exec(fn.body)) !== null) {
        const callee = m[1]!
        // writeJsonSettings/upsertDelimitedBlock/stripDelimitedBlock are themselves the backup mechanism -- calling one of them IS being backed up.
        if (callee === 'writeJsonSettings' || callee === 'upsertDelimitedBlock' || callee === 'stripDelimitedBlock') {
          const lineEnd = fn.body.indexOf('\n', m.index)
          sites.push({ file: relPath, fn: fn.name, call: fn.body.slice(m.index, lineEnd === -1 ? undefined : lineEnd).trim(), covered: true })
          continue
        }
        const lineEnd = fn.body.indexOf('\n', m.index)
        const callText = fn.body.slice(m.index, lineEnd === -1 ? undefined : lineEnd).trim()
        const before = fn.body.slice(0, m.index)
        const backedUp = /\bbackupFile\s*\(/.test(before) || (callee === 'writeIfDifferent' && /,\s*true\s*\)\s*$/.test(callText))
        sites.push({ file: relPath, fn: fn.name, call: callText, covered: backedUp })
      }
    }
  }
  return sites
}

describe('every installer write site backs up the file it overwrites', () => {
  const allSites = scan()
  const population = pinnedPopulation({
    what: 'installer write sites (atomicWriteText/writeFileSync/writeIfDifferent/writeJsonSettings/upsertDelimitedBlock/stripDelimitedBlock calls in src/install.ts and src/bridges/*_install.ts)',
    items: allSites.map((s) => `${s.file}::${s.fn}::${s.call}`),
    floor: 30,
    mustInclude: ['vscode_install.ts::installVscode', 'install.ts::installSkill'],
  })

  it('positive control: the population really does include a covered site (writeJsonSettings) and a would-be-uncovered one an exemption legitimately excuses', () => {
    const jsonSettingsSite = allSites.find((s) => s.call.startsWith('writeJsonSettings('))
    expect(jsonSettingsSite, 'no writeJsonSettings call found at all -- did every settings writer move to something else?').toBeDefined()
    expect(jsonSettingsSite?.covered).toBe(true)

    const shimSite = allSites.find((s) => s.file === 'src/install.ts' && s.fn === 'installHooksScoped' && s.call.includes('CLAUDECODE_HOOK_SCRIPT'))
    expect(shimSite, 'installHooks no longer writes the generated Claude Code hook shim the way this guard expects').toBeDefined()
    expect(shimSite?.covered, 'the generated hook shim now backs itself up -- if intentional, drop its EXEMPT entry instead of leaving it stale').toBe(false)
  })

  it('every EXEMPT entry still matches a real site this guard would otherwise flag', () => {
    for (const exempt of EXEMPT) {
      const site = allSites.find((s) => s.file === exempt.file && s.fn === exempt.fn && s.call === exempt.call)
      expect(site, `EXEMPT entry for ${exempt.file}::${exempt.fn} (${exempt.call}) no longer matches any scanned write site -- did the call text change? Update or remove this stale exemption.`).toBeDefined()
      expect(exempt.reason.trim().length, `EXEMPT entry for ${exempt.file}::${exempt.fn} has an empty reason`).toBeGreaterThan(0)
    }
  })

  it.each(population)('%s is backed up before it overwrites an existing file', (key) => {
    const site = allSites.find((s) => `${s.file}::${s.fn}::${s.call}` === key)
    expect(site, `population entry "${key}" did not round-trip back to a scanned site`).toBeDefined()
    if (site === undefined) return
    const exempt = EXEMPT.find((e) => e.file === site.file && e.fn === site.fn && e.call === site.call)
    if (exempt !== undefined) return
    expect(
      site.covered,
      `${site.file}::${site.fn} calls "${site.call}" with no preceding backupFile(...) (or writeIfDifferent(..., true)) in the same function, and it is not writeJsonSettings/upsertDelimitedBlock/stripDelimitedBlock either. If this write really cannot lose user data, add it to this guard's EXEMPT list with a reason -- do not leave it silently uncovered.`,
    ).toBe(true)
  })
})

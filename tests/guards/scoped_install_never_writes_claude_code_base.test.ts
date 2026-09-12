/**
 * A user who runs `token-goat install --vscode` is asking for VS Code, nothing else. Before this
 * guard existed, `cmdInstall` in `src/cli.ts` ran the base Claude Code install
 * (`installHooks`/`installClaudeMd`/`installSkill`, writing `~/.claude/settings.json`,
 * `~/.claude/CLAUDE.md`, and `~/.claude/skills/token-goat/SKILL.md`) unconditionally, regardless
 * of which harness flag was passed. A real `install --vscode` run rewrote a user's personal,
 * hand-maintained `~/.claude/CLAUDE.md` as a silent side effect of asking for VS Code only.
 * `cmdUninstall` had the same shape: a bare `uninstall --vscode` also silently stripped the
 * caller's Claude Code hooks, CLAUDE.md block, and skill.
 *
 * This repo has shipped this exact class before: a user-scoped install once wrote a `.github`
 * directory into the current working directory. That makes "a scope flag writes outside the
 * files it declares" a class to guard, not a one-off to re-patch each time a new harness flag is
 * added. `src/cli.ts`'s `wantsClaudeCodeBase` is the fix: every harness-scope branch in
 * `cmdInstall` must never call the three Claude-Code-owned install functions except from inside
 * the `wantsClaudeCodeBase` gate itself, and `cmdUninstall`'s three Claude-Code-owned uninstall
 * calls must never appear outside its own `wantsClaudeCodeBase` gate.
 *
 * This is a structural guard (source text only, no I/O beyond reading this repo's own files, no
 * spawn) with a pinned, non-empty population -- FORMAT-DERIVED from cli.ts's own `cmdInstall`
 * option type, read directly below -- so a new harness flag added later starts unclassified
 * (caught by the floor) rather than silently inheriting a pass.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts')

/** Strips comments, same naive-but-safe tradeoff every other regex/text guard in this directory makes. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** Calls that only the `wantsClaudeCodeBase(opts)` gate (or its documented `--hermes` exception) may reach. */
const CLAUDE_CODE_BASE_INSTALL_CALLS = [/\binstallHooks\(/, /\binstallClaudeMd\(/, /\binstallSkill\(/]
const CLAUDE_CODE_BASE_UNINSTALL_CALLS = [/\buninstallHooks\(/, /\buninstallClaudeMd\(/, /\buninstallSkill\(/]

/**
 * Every harness-scope flag `cmdInstall`/`cmdUninstall` accept, other than `project`, `local`,
 * `purge`, and `hermes` (modifiers/exceptions, not scopes of their own). FORMAT-DERIVED: read
 * directly from `cmdInstall`'s own parameter type in `src/cli.ts`, not from this guard's own idea
 * of what the flags are.
 */
const HARNESS_SCOPE_FLAGS = [
  'codex',
  'gemini',
  'qwen',
  'kimi',
  'pi',
  'opencode',
  'openclaw',
  'copilot',
  'grok',
  'vscode',
  'visualstudio',
  'zed',
  'cursor',
] as const

/**
 * Extracts the brace-balanced body of the first `if (opts.<flag> === true) {` block found at or
 * after `fromIndex`. Returns null if no such branch exists in this slice.
 */
function extractOptBlock(code: string, flag: string, fromIndex: number): string | null {
  const marker = `if (opts.${flag} === true) {`
  const start = code.indexOf(marker, fromIndex)
  if (start === -1) return null
  return extractBalancedBlock(code, start + marker.length - 1)
}

/** Extracts the brace-balanced block starting at `openBraceIndex` (which must be a `{`). */
function extractBalancedBlock(code: string, openBraceIndex: number): string {
  let depth = 0
  let i = openBraceIndex
  const start = openBraceIndex
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) return code.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces starting at index ${openBraceIndex}`)
}

/**
 * The whole brace-balanced body of a `function name(...) { ... }` / `async function name(...) { ... }`
 * declaration. `cmdInstall`/`cmdUninstall` both take an inline `opts: { ... }` object-type parameter,
 * so the first `{` after `declarationIndex` opens that type annotation, not the function body -- the
 * body's own `{` is the one right after the return-type annotation (`): Promise<void> {` /
 * `): void {`), found by scanning past the parameter list's own balanced braces first.
 */
function extractFunctionBody(code: string, declarationIndex: number): string {
  const paramListOpen = code.indexOf('(', declarationIndex)
  let depth = 0
  let i = paramListOpen
  for (; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')') {
      depth--
      if (depth === 0) break
    }
  }
  const openBrace = code.indexOf('{', i)
  return extractBalancedBlock(code, openBrace)
}

describe('scoped install/uninstall never silently touches the Claude Code base', () => {
  const code = stripComments(fs.readFileSync(CLI_PATH, 'utf8'))
  const installDeclIdx = code.indexOf('async function cmdInstall(')
  const uninstallDeclIdx = code.indexOf('function cmdUninstall(')
  expect(installDeclIdx, 'cmdInstall not found in src/cli.ts -- did it move or get renamed?').toBeGreaterThan(-1)
  expect(uninstallDeclIdx, 'cmdUninstall not found in src/cli.ts -- did it move or get renamed?').toBeGreaterThan(-1)

  const cmdInstallBody = extractFunctionBody(code, installDeclIdx)
  const cmdUninstallBody = extractFunctionBody(code, uninstallDeclIdx)

  const scopes = pinnedPopulation({
    what: 'harness-scope install/uninstall flags in cmdInstall/cmdUninstall',
    items: [...HARNESS_SCOPE_FLAGS],
    floor: 10,
    mustInclude: ['vscode', 'codex'],
  })

  it.each(scopes)("cmdInstall's --%s branch never calls a Claude-Code-base install function", (flag) => {
    const block = extractOptBlock(cmdInstallBody, flag, 0)
    expect(block, `--${flag} has no "if (opts.${flag} === true) {" branch in cmdInstall -- update this guard's extraction if the shape changed`).not.toBeNull()
    for (const re of CLAUDE_CODE_BASE_INSTALL_CALLS) {
      expect(block, `cmdInstall's --${flag} branch calls ${re} -- a scoped harness install must not also touch ~/.claude/. Route through wantsClaudeCodeBase if this is intentional.`).not.toMatch(re)
    }
  })

  it("cmdUninstall's Claude-Code-base uninstall calls appear only inside its wantsClaudeCodeBase gate", () => {
    const gateStart = cmdUninstallBody.indexOf('if (wantsClaudeCodeBase(opts)) {')
    expect(gateStart, 'wantsClaudeCodeBase gate not found in cmdUninstall -- did the fix get reverted?').toBeGreaterThan(-1)
    const gatedBlock = extractBalancedBlock(cmdUninstallBody, cmdUninstallBody.indexOf('{', gateStart))
    const outsideGate = cmdUninstallBody.slice(0, gateStart) + cmdUninstallBody.slice(gateStart + gatedBlock.length)

    // Positive control: the gate really does call all three, proving this scan isn't just failing to match anything.
    for (const re of CLAUDE_CODE_BASE_UNINSTALL_CALLS) {
      expect(gatedBlock, `wantsClaudeCodeBase gate in cmdUninstall no longer calls ${re}`).toMatch(re)
    }
    // The actual guard: none of the three calls escape the gate into an unconditional or
    // per-scope branch (e.g. the vscode/visualstudio/cursor entries in the `removals` table).
    for (const re of CLAUDE_CODE_BASE_UNINSTALL_CALLS) {
      expect(outsideGate, `cmdUninstall calls ${re} outside its wantsClaudeCodeBase gate -- a scoped harness uninstall must not also strip ~/.claude/.`).not.toMatch(re)
    }
  })

  it("positive control: cmdInstall's wantsClaudeCodeBase-gated section really does call all three install functions", () => {
    const gateStart = cmdInstallBody.indexOf('if (wantsClaudeCodeBase(opts)) {')
    expect(gateStart, 'wantsClaudeCodeBase gate not found in cmdInstall -- did the fix get reverted?').toBeGreaterThan(-1)
    const gatedBlock = extractBalancedBlock(cmdInstallBody, cmdInstallBody.indexOf('{', gateStart))
    for (const re of CLAUDE_CODE_BASE_INSTALL_CALLS) {
      expect(gatedBlock, `wantsClaudeCodeBase gate in cmdInstall no longer calls ${re}`).toMatch(re)
    }
  })

  it('positive control: --hermes is the documented exception, and forces wantsClaudeCodeBase true', () => {
    const fnBody = code.slice(code.indexOf('function wantsClaudeCodeBase('), installDeclIdx)
    expect(fnBody, 'wantsClaudeCodeBase must force the base install when --hermes is passed (it genuinely depends on it)').toMatch(/opts\.hermes === true/)
  })
})

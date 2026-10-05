/** In bypassPermissions the user is never prompted, and auto mode follows the same rule: a rewrite there is either approved (`allow`, so the call stays prompt-free) or not made, never deferred to Claude Code's permission flow, and nothing token-goat emits ever answers `ask`. HAND-DERIVED from that rule (docs/security.md, "Rewrites never change a permission outcome"). Three checks: a sweep of the central decision over every rewrite kind, mode-relevant snapshot and hidden-source answer; no source file writes an `ask` decision; and no source file but rewrite_permission.ts builds a `rewriteInput` output, so every rewrite passes through that decision. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { decideRewrite, snapshotFromDocs, type RewriteKind, type RewriteRequest } from '../../src/rewrite_permission.js'

import { pinnedPopulation } from './population.js'

const SRC = path.resolve(__dirname, '..', '..', 'src')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []))
}

function sourceFiles(dir: string): readonly string[] {
  return pinnedPopulation({ what: 'src/**/*.ts files scanned for ask decisions and rewriteInput builders', items: walk(dir), floor: 300, mustInclude: ['rewrite_permission.ts', 'hook_registry.ts', 'hooks_bash.ts', 'image_shrink.ts', 'hooks_agent_spawn.ts', path.join('bridges', 'copilot_cli.ts')] })
}

const CWD = path.join(os.tmpdir(), 'tg-guard-never-prompt')
const SNAPSHOTS = [
  snapshotFromDocs([]),
  snapshotFromDocs([{ role: 'user', json: { permissions: { allow: ['Bash(go build:*)', 'Bash(*)', 'Read(**)'] } } }]),
  snapshotFromDocs([{ role: 'user', json: { permissions: { deny: ['Bash(curl:*)', 'Read(./private/**)'] } } }]),
  snapshotFromDocs([{ role: 'user', json: { permissions: { ask: ['Bash(curl *)', 'Agent(Explore)'] } } }]),
  snapshotFromDocs([{ role: 'project', json: { permissions: { allow: ['Bash(go build *)'] } } }]),
  snapshotFromDocs([{ role: 'user', json: { hooks: { PermissionRequest: [] } } }]),
]
const ORIGINALS: Record<RewriteKind, readonly string[]> = {
  'shell-wrap': ['go build ./...', 'curl -s https://example.com', 'ls -la src', 'git status --short', 'npm test 2>&1 | tail', 'timeout 5 go build ./...'],
  'shell-query': ['rg -n "^export function" src', 'grep -rn TODO .'],
  read: [path.join(CWD, 'a.png'), path.join(CWD, 'private', 'b.png'), path.join(os.homedir(), 'c.png')],
  agent: ['find the bug'],
}

describe('bypassPermissions and auto never get a deferred rewrite or a prompt', () => {
  it('the central decision answers only skip or approve in both modes, and only skip in auto', () => {
    let checked = 0
    for (const mode of ['auto', 'bypassPermissions'] as const) {
      for (const [kind, originals] of Object.entries(ORIGINALS) as [RewriteKind, readonly string[]][]) {
        for (const original of originals) {
          for (const snapshot of SNAPSHOTS) {
            for (const hidden of [true, false]) {
              for (const insideCwd of [true, false]) {
                const req: RewriteRequest = { kind, harness: 'claudecode', mode, cwd: CWD, original, rewritten: `${original} rewritten`, insideCwd }
                const verdict = decideRewrite(snapshot, req, () => hidden)
                expect(mode === 'auto' ? ['skip'] : ['skip', 'approve'], `${mode} ${kind} ${original}`).toContain(verdict)
                if (hidden) expect(verdict, `${mode} ${kind} ${original} with a hidden source`).toBe('skip')
                checked++
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(2 * 12 * SNAPSHOTS.length * 4)
  })

  it('no source file writes an ask decision', () => {
    const offenders = sourceFiles(SRC).filter((f) => /\b(?:permissionDecision|decision|behavior)["']?\s*:\s*["'`]ask["'`]/.test(fs.readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('only rewrite_permission.ts builds a rewriteInput output, so every rewrite passes the central decision', () => {
    const builders = sourceFiles(SRC).filter((f) => /(?<!readonly\s)hookType:\s*["']rewriteInput["']/.test(fs.readFileSync(f, 'utf8')))
    expect(builders.map((f) => path.relative(SRC, f))).toEqual(['rewrite_permission.ts'])
  })
})

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const hooksWrite = fs.readFileSync(path.join(repo, 'src', 'hooks_write.ts'), 'utf8')
const hooksBash = fs.readFileSync(path.join(repo, 'src', 'hooks_bash.ts'), 'utf8')
const deadlineRs = fs.readFileSync(path.join(repo, 'native', 'tg-hook', 'src', 'deadline.rs'), 'utf8')

// The tool names that pre_tool_use registrations of one handler name, e.g. Write, Edit and MultiEdit for preWriteRewriteHandler.
function registeredTools(source: string, handler: string): string[] {
  const re = new RegExp(`registerHook\\('pre_tool_use', ${handler}, \\{ toolName: '([^']+)' \\}\\)`, 'g')
  return [...source.matchAll(re)].map((m) => m[1])
}

// The folded tool names listed in deadline.rs tool_of under one class arm, e.g. Write.
function nativeArm(arm: string): string[] {
  const re = /^\s*((?:"[a-z]+"\s*\|\s*)*"[a-z]+")\s*=> Tool::(\w+),/gm
  const names: string[] = []
  for (const m of deadlineRs.matchAll(re)) {
    if (m[2] === arm) names.push(...[...m[1].matchAll(/"([a-z]+)"/g)].map((n) => n[1]))
  }
  return names
}

function folded(names: string[]): string[] {
  return names.map((name) => name.toLowerCase().replace(/[_-]/g, '')).sort()
}

describe('native deadline busy set mirrors node', () => {
  // FORMAT-DERIVED: src/hooks_write.ts and src/hooks_bash.ts pre_tool_use registrations, against deadline.rs tool_of.
  it('answers busy for exactly the tools node PreToolUse write and shell guards register', () => {
    const nodeWrite = registeredTools(hooksWrite, 'preWriteRewriteHandler')
    const nodeShell = registeredTools(hooksBash, 'preShell')
    expect(nodeWrite.length, 'src/hooks_write.ts no longer registers its write guard on pre_tool_use').toBeGreaterThan(0)
    expect(nodeShell.length, 'src/hooks_bash.ts no longer registers its shell guard on pre_tool_use').toBeGreaterThan(0)
    expect(folded(nativeArm('Write')), 'deadline.rs Write arm differs from the write guard names in src/hooks_write.ts').toEqual(folded(nodeWrite))
    expect(folded(nativeArm('Shell')), 'deadline.rs Shell arm differs from the shell guard names in src/hooks_bash.ts').toEqual(folded(nodeShell))
  })
})

import { describe, it, expect } from 'vitest'
import type { HookEvent } from '../src/hook_registry.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { extractTailFile, extractTasksOutput, extractToolResultsFile, extractRgSymbolSearch, extractMarkdownHeadingGrep } from '../src/bash_extractors.js'

// BE-22: the short-flag tests in bash_extractors.ts were `/-f\b/`, `/-c\b/`, `/-n\b/` and `/-n\s*\+/` against the whole command, so a `-f`, `-c` or `-n` inside a name (the `.` after `appendix-c` is a word boundary) was taken for the flag. HAND-DERIVED: every command below is shell grammar written from tail(1), grep(1) and rg(1) option syntax, not from the extractors' regexes; the Claude Code project-folder spelling in the tasks and tool-results paths (every non-alphanumeric character of the working directory becomes `-`) is FORMAT-DERIVED from the CAPTURE comment at tests/hooks_bash.test.ts, where `C:\Projects\claude-agents` is spelled `C--Projects-claude-agents`. CAPTURE (this machine, 2026-09-30, the installed 2.9.29-era build of 33e5507a fed a PreToolUse Bash payload through `token-goat hook pre_tool_use` under an isolated home): over three copies of one 120-line markdown file, `tail -n 50 docs/notes.md` drew the tail hint while `tail -n 50 docs/appendix-c.md` and `tail -n 50 docs/notes-f.md` returned `{}`.

function makeBashEvent(command: string): HookEvent {
  return makeHookEvent({ toolName: 'Bash', toolInput: { command }, sessionId: 'test-session', agentId: undefined, raw: {} })
}

describe('BE-22: a flag letter inside a name is not the flag', () => {
  it.each([
    'tail -n 50 docs/appendix-c.md',
    'tail -n 50 docs/notes-f.md',
    'tail -50 docs/a-n+b.md',
    'cat docs/appendix-c.md | tail -50',
  ])('extractTailFile reads %s', (cmd) => {
    const r = extractTailFile(cmd)
    expect(r).not.toBeNull()
    expect(r?.filePath).toMatch(/^docs\/a|^docs\/notes/)
  })

  it('a name ending -c draws the same tail hint as one without', () => {
    const plain = preBashHandler(makeBashEvent('tail -n 50 docs/appendix.md'))
    const dashed = preBashHandler(makeBashEvent('tail -n 50 docs/appendix-c.md'))
    expect(plain.hookType).toBe('context')
    expect(dashed.hookType).toBe('context')
    if (dashed.hookType === 'context') expect(dashed.context).toContain('docs/appendix-c.md')
  })

  it.each([
    'tail -f docs/a.md',
    'tail -c 100 docs/a.md',
    'tail -n +5 docs/a.md',
    'tail -n+5 docs/a.md',
    'tail +5 docs/a.md',
    'tail -F docs/a.md',
    'tail --follow docs/a.md',
    'cat docs/a.md | tail -f',
    'cat docs/a.md | tail -c 400',
    'cat docs/a.md | tail -n +5',
  ])('extractTailFile still declines the streaming, byte or offset form %s', (cmd) => {
    expect(extractTailFile(cmd)).toBeNull()
  })

  const TASKS = 'C:/Users/<user>/AppData/Local/Temp/claude/C--Projects-f-droid/0d84f3c6/tasks/a2af08af400178684.output'
  const RESULTS = 'C:/Users/<user>/.claude/projects/C--Projects-f-droid/0d84f3c6/tool-results/toolu_01abc.txt'

  it('extractTasksOutput reads a tasks file under a project folder spelled with -f', () => {
    expect(extractTasksOutput(`tail -n 20 ${TASKS}`)).toEqual({ id: 'a2af08af400178684', path: TASKS, n: 20 })
    expect(extractTasksOutput(`tail -c 1500 ${TASKS}`)).toEqual({ id: 'a2af08af400178684', path: TASKS })
  })

  it('extractToolResultsFile reads a tool-results file under a project folder spelled with -f', () => {
    expect(extractToolResultsFile(`tail -n 20 ${RESULTS}`)).toEqual({ path: RESULTS })
  })

  it.each([`tail -f ${TASKS}`, `tail -n +5 ${TASKS}`])('extractTasksOutput still declines %s', (cmd) => {
    expect(extractTasksOutput(cmd)).toBeNull()
  })

  it.each([`tail -f ${RESULTS}`, `tail -n +5 ${RESULTS}`])('extractToolResultsFile still declines %s', (cmd) => {
    expect(extractToolResultsFile(cmd)).toBeNull()
  })

  it('a -n inside a name is not the -n that extractRgSymbolSearch and extractMarkdownHeadingGrep require', () => {
    expect(extractRgSymbolSearch('rg "ConversationState" src/state-n.ts')).toBeNull()
    expect(extractMarkdownHeadingGrep('grep "^#" docs/appendix-n.md')).toBeNull()
  })

  it.each([
    ['grep -rn "^#" docs/guide.md'],
    ['grep -nH "^#" docs/guide.md'],
    ['rg --line-number "^#" docs/guide.md'],
  ])('extractMarkdownHeadingGrep takes -n bundled or spelled long: %s', (cmd) => {
    expect(extractMarkdownHeadingGrep(cmd)).toEqual({ filePath: 'docs/guide.md' })
  })

  it.each([
    ['grep -wn "ConversationState" src/types/domain.ts'],
    ['rg --line-number "ConversationState" src/types/domain.ts'],
  ])('extractRgSymbolSearch takes -n bundled or spelled long: %s', (cmd) => {
    expect(extractRgSymbolSearch(cmd)).toEqual({ filePath: 'src/types/domain.ts', identifier: 'ConversationState' })
  })
})

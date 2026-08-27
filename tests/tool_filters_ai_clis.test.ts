/**
 * Tests for the AI-CLI streaming assistant filter family (Batch I).
 *
 * Covers: AiderFilter, GhCopilotFilter, CopilotFilter, GeminiCliFilter,
 * ClaudeCliFilter, CursorFilter, WindsurfFilter, OpenCodeFilter,
 * ContinueFilter, ClineFilter, CodexExecFilter.
 *
 * Ported from the Python AI-CLI test suite (git ref 2098981^).
 */
import { describe, expect, it } from 'vitest'

import {
  AI_CLI_FILTERS,
  aiderFilter,
  ghCopilotFilter,
  copilotFilter,
  geminiCliFilter,
  claudeCliFilter,
  cursorFilter,
  windsurfFilter,
  openCodeFilter,
  continueFilter,
  clineFilter,
  CodexExecFilter,
  codexExecFilter,
} from '../src/tool_filters/ai_clis.js'
import { selectFilter } from '../src/tool_filters/dispatch.js'
import type { ToolFilter } from '../src/tool_filters/base.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apply(
  filter: ToolFilter,
  stdout: string,
  argv: string[],
  { stderr = '', exitCode = 0 } = {},
): string {
  return filter.compress(stdout, stderr, exitCode, argv)
}

// ---------------------------------------------------------------------------
// AI_CLI_FILTERS array sanity
// ---------------------------------------------------------------------------

describe('AI_CLI_FILTERS array', () => {
  it('contains all 11 filters', () => {
    expect(AI_CLI_FILTERS).toHaveLength(11)
  })

  it('ghCopilotFilter is first (must precede GhFilter in TOOL_FILTERS)', () => {
    expect(AI_CLI_FILTERS[0]).toBe(ghCopilotFilter)
  })

  it('every filter in the array has a unique name', () => {
    const names = AI_CLI_FILTERS.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

// ---------------------------------------------------------------------------
// GhCopilotFilter — dispatch
// ---------------------------------------------------------------------------

describe('GhCopilotFilter dispatch', () => {
  it('matches gh copilot explain', () => {
    expect(ghCopilotFilter.matches(['gh', 'copilot', 'explain', 'what is git rebase'])).toBe(true)
  })

  it('matches gh copilot suggest', () => {
    expect(ghCopilotFilter.matches(['gh', 'copilot', 'suggest', 'how to list files'])).toBe(true)
  })

  it('does not match gh copilot with no action subcommand', () => {
    expect(ghCopilotFilter.matches(['gh', 'copilot'])).toBe(false)
  })

  it('does not match gh pr list', () => {
    expect(ghCopilotFilter.matches(['gh', 'pr', 'list'])).toBe(false)
  })

  it('does not match gh copilot other-subcmd', () => {
    expect(ghCopilotFilter.matches(['gh', 'copilot', 'alias', 'list'])).toBe(false)
  })

  it('does not match empty argv', () => {
    expect(ghCopilotFilter.matches([])).toBe(false)
  })

  it('selectFilter routes gh copilot explain to ghCopilotFilter', () => {
    const f = selectFilter(['gh', 'copilot', 'explain', 'what is git rebase'])
    expect(f?.name).toBe('gh-copilot')
  })

  it('selectFilter does NOT route gh pr list to ghCopilotFilter', () => {
    const f = selectFilter(['gh', 'pr', 'list'])
    expect(f?.name).not.toBe('gh-copilot')
  })
})

// ---------------------------------------------------------------------------
// GhCopilotFilter — compression
// ---------------------------------------------------------------------------

const _GH_COPILOT_EXPLAIN = [
  'Welcome to GitHub Copilot in the CLI!',
  'version 1.0.0 (2024-01-15)',
  'Authenticated as octocat',
  'Asking GitHub Copilot...',
  'Thinking...',
  '',
  'Git rebase is a command that integrates changes from one branch into another.',
  'It rewrites history by creating new commits.',
  '',
  'Disclaimer: This is AI-generated content.',
  'Note: Always verify the output.',
].join('\n')

describe('GhCopilotFilter compression', () => {
  const argv = ['gh', 'copilot', 'explain', 'what is git rebase']

  it('drops banner and spinner lines', () => {
    const out = apply(ghCopilotFilter, _GH_COPILOT_EXPLAIN, argv)
    expect(out).not.toContain('Welcome to GitHub Copilot')
    expect(out).not.toContain('Authenticated as')
    expect(out).not.toContain('Asking GitHub Copilot')
    expect(out).not.toContain('Thinking...')
  })

  it('drops disclaimer and note lines', () => {
    const out = apply(ghCopilotFilter, _GH_COPILOT_EXPLAIN, argv)
    expect(out).not.toContain('Disclaimer:')
    expect(out).not.toContain('Note: Always verify')
  })

  it('keeps the response body', () => {
    const out = apply(ghCopilotFilter, _GH_COPILOT_EXPLAIN, argv)
    expect(out).toContain('Git rebase is a command')
    expect(out).toContain('rewrites history')
  })

  it('emits dropped-noise note', () => {
    const out = apply(ghCopilotFilter, _GH_COPILOT_EXPLAIN, argv)
    expect(out).toContain('[token-goat:')
    expect(out.toLowerCase()).toContain('boilerplate')
  })
})

// ---------------------------------------------------------------------------
// CopilotFilter — dispatch
// ---------------------------------------------------------------------------

describe('CopilotFilter dispatch', () => {
  it('matches copilot binary', () => {
    expect(copilotFilter.matches(['copilot'])).toBe(true)
  })

  it('does not match gh copilot (different binary)', () => {
    expect(copilotFilter.matches(['gh', 'copilot', 'explain', 'x'])).toBe(false)
  })

  it('selectFilter routes copilot to copilotFilter', () => {
    const f = selectFilter(['copilot', '--help'])
    expect(f?.name).toBe('copilot')
  })
})

// ---------------------------------------------------------------------------
// CopilotFilter — compression
// ---------------------------------------------------------------------------

const _COPILOT_STANDALONE_EXPLAIN = [
  'GitHub Copilot v1.0.3',
  'Authenticated as: octocat',
  'Starting Copilot workspace',
  'Loading model: gpt-4o',
  'Generating...',
  '',
  'Here is how you can use git rebase to clean up commits.',
  '',
  'Completion tokens: 1234',
  'Prompt tokens: 567',
  'Always review AI-generated suggestions.',
].join('\n')

describe('CopilotFilter compression', () => {
  const argv = ['copilot', 'explain', 'what is git rebase']

  it('drops workspace noise and spinner', () => {
    const out = apply(copilotFilter, _COPILOT_STANDALONE_EXPLAIN, argv)
    expect(out).not.toContain('GitHub Copilot v1.0.3')
    expect(out).not.toContain('Starting Copilot workspace')
    expect(out).not.toContain('Loading model:')
    expect(out).not.toContain('Generating...')
  })

  it('keeps the response body', () => {
    const out = apply(copilotFilter, _COPILOT_STANDALONE_EXPLAIN, argv)
    expect(out).toContain('Here is how you can use git rebase')
  })

  it('emits stats note from last completion line', () => {
    const out = apply(copilotFilter, _COPILOT_STANDALONE_EXPLAIN, argv)
    expect(out).toContain('[token-goat:')
    expect(out.toLowerCase()).toContain('stats')
  })
})

// ---------------------------------------------------------------------------
// AiderFilter — dispatch
// ---------------------------------------------------------------------------

describe('AiderFilter dispatch', () => {
  it('matches aider binary', () => {
    expect(aiderFilter.matches(['aider'])).toBe(true)
  })

  it('matches aider with flags', () => {
    expect(aiderFilter.matches(['aider', '--model', 'claude-3-5-sonnet'])).toBe(true)
  })

  it('does not match other binaries', () => {
    expect(aiderFilter.matches(['npm'])).toBe(false)
    expect(aiderFilter.matches([])).toBe(false)
  })

  it('selectFilter routes aider to aiderFilter', () => {
    const f = selectFilter(['aider'])
    expect(f?.name).toBe('aider')
  })
})

// ---------------------------------------------------------------------------
// AiderFilter — compression
// ---------------------------------------------------------------------------

const _AIDER_VERBOSE = [
  'aider v0.52.1',
  'Aider v0.52.1',
  'Tokens: 12345 sent, 1234 received. Cost: $0.0456 message, $0.1234 session.',
  'Repo-map: using 4096 tokens, auto refresh',
  'Added src/main.py to the chat',
  'Applying edits to src/main.py...',
  'Applying edits to src/test.py...',
  'Applied edit to src/main.py.',
  'Applied edit to src/test.py.',
  'Diff:',
  'Your fix looks correct.',
  'Use ctrl-c to interrupt',
  'Tip: use --model to change model',
].join('\n')

describe('AiderFilter compression', () => {
  const argv = ['aider']

  it('drops banner and repo-map noise', () => {
    const out = apply(aiderFilter, _AIDER_VERBOSE, argv)
    expect(out).not.toContain('aider v0.52')
    expect(out).not.toContain('Repo-map:')
    expect(out).not.toContain('Added src/main.py to the chat')
  })

  it('drops footer noise', () => {
    const out = apply(aiderFilter, _AIDER_VERBOSE, argv)
    expect(out).not.toContain('ctrl-c')
    expect(out).not.toContain('Tip:')
  })

  it('prepends applying-edits collapse notice', () => {
    const out = apply(aiderFilter, _AIDER_VERBOSE, argv)
    expect(out).toContain("[token-goat: 4 'applying edits' progress line(s) collapsed")
    // The prepended line comes before the kept body
    const prepIdx = out.indexOf('[token-goat:')
    const bodyIdx = out.indexOf('Your fix looks correct.')
    expect(prepIdx).toBeLessThan(bodyIdx)
  })

  it('keeps actual content lines', () => {
    const out = apply(aiderFilter, _AIDER_VERBOSE, argv)
    expect(out).toContain('Your fix looks correct.')
    expect(out).toContain('Diff:')
  })

  it('emits token usage in trailing note', () => {
    const out = apply(aiderFilter, _AIDER_VERBOSE, argv)
    // The token line contains the cost info too
    expect(out).toMatch(/0\.0456|cost/i)
  })

  it('no applying-edits prepend when none present', () => {
    const plain = 'Here is the answer.\n'
    const out = apply(aiderFilter, plain, argv)
    expect(out).not.toContain('[token-goat:')
  })
})

// ---------------------------------------------------------------------------
// GeminiCliFilter — dispatch + compression
// ---------------------------------------------------------------------------

describe('GeminiCliFilter dispatch', () => {
  it('matches gemini binary', () => {
    expect(geminiCliFilter.matches(['gemini'])).toBe(true)
  })

  it('selectFilter routes gemini to geminiCliFilter', () => {
    const f = selectFilter(['gemini', '-p', 'hello'])
    expect(f?.name).toBe('gemini-cli')
  })
})

const _GEMINI_VERBOSE = [
  'Gemini CLI v0.1.4',
  '✓ Model: gemini-2.0-flash-exp',
  '✓ Theme: Default',
  '✓ Tools: built-in',
  'Thinking...',
  'Type /help for commands',
  '⠋ Calling executeCode',
  '⠙ Calling readFile',
  '',
  'Here is the result of running your code.',
  '',
  'Context: 1234/32768',
].join('\n')

describe('GeminiCliFilter compression', () => {
  const argv = ['gemini', '-p', 'run my script']

  it('drops banner, thinking, and footer noise', () => {
    const out = apply(geminiCliFilter, _GEMINI_VERBOSE, argv)
    expect(out).not.toContain('Gemini CLI v0.1.4')
    expect(out).not.toContain('Thinking...')
    expect(out).not.toContain('Type /help')
  })

  it('prepends startup status collapse notice', () => {
    const out = apply(geminiCliFilter, _GEMINI_VERBOSE, argv)
    expect(out).toContain('[token-goat: 3 Gemini CLI startup status line(s) collapsed')
  })

  it('prepends tool-call spinner collapse notice', () => {
    const out = apply(geminiCliFilter, _GEMINI_VERBOSE, argv)
    expect(out).toContain('[token-goat: 2 tool-call spinner line(s) collapsed]')
  })

  it('keeps the response body', () => {
    const out = apply(geminiCliFilter, _GEMINI_VERBOSE, argv)
    expect(out).toContain('Here is the result of running your code.')
  })

  it('emits context note from token meter', () => {
    const out = apply(geminiCliFilter, _GEMINI_VERBOSE, argv)
    expect(out).toContain('[token-goat:')
    expect(out.toLowerCase()).toContain('context')
  })
})

// ---------------------------------------------------------------------------
// ClaudeCliFilter — dispatch (custom matches)
// ---------------------------------------------------------------------------

describe('ClaudeCliFilter dispatch', () => {
  it('matches plain claude invocation', () => {
    expect(claudeCliFilter.matches(['claude'])).toBe(true)
  })

  it('matches claude with non-management subcommand', () => {
    expect(claudeCliFilter.matches(['claude', 'chat', 'hello'])).toBe(true)
  })

  it('skips management subcommands', () => {
    for (const sub of ['install', 'update', 'doctor', 'config', 'login', 'logout']) {
      expect(claudeCliFilter.matches(['claude', sub])).toBe(false)
    }
  })

  it('does not match claude-dev (different stem)', () => {
    // 'claude-dev' stem is 'claude-dev', not 'claude'
    expect(claudeCliFilter.matches(['claude-dev'])).toBe(false)
  })

  it('selectFilter routes claude to claudeCliFilter', () => {
    const f = selectFilter(['claude'])
    expect(f?.name).toBe('claude-cli')
  })
})

// ---------------------------------------------------------------------------
// ClaudeCliFilter — compression
// ---------------------------------------------------------------------------

const _CLAUDE_CLI_VERBOSE = [
  '◆ claude-3-5-sonnet-20241022',
  '◎ Thinking...',
  '> Using tool: Bash',
  '✓ Tool result: 0 exit',
  '◎ Thinking...',
  '↑ 5000 ↓ 1234 tokens',
  'Context: 6234/200000',
  'Press Ctrl+C to exit',
  '',
  'The analysis is complete. Here are the findings.',
].join('\n')

describe('ClaudeCliFilter compression', () => {
  const argv = ['claude']

  it('drops model header, spinner, and footer', () => {
    const out = apply(claudeCliFilter, _CLAUDE_CLI_VERBOSE, argv)
    expect(out).not.toContain('claude-3-5-sonnet')
    expect(out).not.toContain('Thinking...')
    expect(out).not.toContain('Press Ctrl+C')
  })

  it('counts tool-log lines as note (not prepend/append)', () => {
    const out = apply(claudeCliFilter, _CLAUDE_CLI_VERBOSE, argv)
    expect(out).toContain('[token-goat:')
    expect(out.toLowerCase()).toContain('tool-call log')
    // tool-log note appears in the trailing [token-goat: ...] line, not as a prepend
    const noteIdx = out.lastIndexOf('[token-goat:')
    const bodyIdx = out.indexOf('The analysis is complete.')
    expect(noteIdx).toBeGreaterThan(bodyIdx)
  })

  it('keeps the response body', () => {
    const out = apply(claudeCliFilter, _CLAUDE_CLI_VERBOSE, argv)
    expect(out).toContain('The analysis is complete. Here are the findings.')
  })

  it('emits stats and context notes', () => {
    const out = apply(claudeCliFilter, _CLAUDE_CLI_VERBOSE, argv)
    expect(out.toLowerCase()).toContain('stats')
    expect(out.toLowerCase()).toContain('context')
  })
})

// ---------------------------------------------------------------------------
// CursorFilter — dispatch + compression
// ---------------------------------------------------------------------------

describe('CursorFilter dispatch', () => {
  it('matches cursor binary', () => {
    expect(cursorFilter.matches(['cursor'])).toBe(true)
  })

  it('selectFilter routes cursor to cursorFilter', () => {
    const f = selectFilter(['cursor', '.'])
    expect(f?.name).toBe('cursor')
  })
})

const _CURSOR_STARTUP_VERBOSE = [
  'Cursor v0.42.1',
  'Extension host started',
  "Extension 'cursor.cursor-retrieval' activated",
  'Starting debug adapter',
  'Telemetry is disabled',
  'Crash reporter: enabled',
  // "Opening folder..." (bare dots) matches the startup regex; a path like "Opening folder /projects/myapp..." does NOT — that is kept intentionally.
  'Opening folder...',
  '',
  '> Your project is loaded successfully.',
  'Error: failed to load extension cursor.bad-ext',
].join('\n')

describe('CursorFilter compression', () => {
  const argv = ['cursor', '.']

  it('drops banner, startup, and telemetry noise', () => {
    const out = apply(cursorFilter, _CURSOR_STARTUP_VERBOSE, argv)
    expect(out).not.toContain('Cursor v0.42')
    expect(out).not.toContain('Extension host started')
    expect(out).not.toContain('Telemetry is disabled')
    expect(out).not.toContain('Crash reporter')
    expect(out).not.toContain('Opening folder')
  })

  it('keeps actual output lines', () => {
    const out = apply(cursorFilter, _CURSOR_STARTUP_VERBOSE, argv)
    expect(out).toContain('Your project is loaded successfully.')
  })

  it('keeps error signal lines', () => {
    const out = apply(cursorFilter, _CURSOR_STARTUP_VERBOSE, argv)
    expect(out).toContain('Error: failed to load extension cursor.bad-ext')
  })

  it('emits startup/telemetry noise note', () => {
    const out = apply(cursorFilter, _CURSOR_STARTUP_VERBOSE, argv)
    expect(out).toContain('[token-goat:')
    expect(out.toLowerCase()).toContain('startup')
  })
})

// ---------------------------------------------------------------------------
// WindsurfFilter — dispatch + compression
// ---------------------------------------------------------------------------

describe('WindsurfFilter dispatch', () => {
  it('matches windsurf binary', () => {
    expect(windsurfFilter.matches(['windsurf'])).toBe(true)
  })

  it('selectFilter routes windsurf to windsurfFilter', () => {
    const f = selectFilter(['windsurf', '.'])
    expect(f?.name).toBe('windsurf')
  })
})

const _WINDSURF_STARTUP_VERBOSE = [
  'Windsurf 1.3.0',
  'Extension host started',
  "Extension 'codeium.codeium' activated",
  'Codeium: Activating...',
  'Codeium index: loading...',
  'Connecting to Codeium server',
  'Authentication status: authenticated',
  'Model status: ready',
  'Telemetry is disabled',
  'Opening folder...',
  '',
  '> Cascade is ready.',
  'Your workspace has 127 Python files.',
  'Context: 5000/200000',
  'Cascade is reading src/main.py',
  'Cascade is writing src/main.py',
].join('\n')

describe('WindsurfFilter compression', () => {
  const argv = ['windsurf', '.']

  it('drops banner, startup, codeium noise, and telemetry', () => {
    const out = apply(windsurfFilter, _WINDSURF_STARTUP_VERBOSE, argv)
    expect(out).not.toContain('Windsurf 1.3.0')
    expect(out).not.toContain('Extension host started')
    expect(out).not.toContain('Codeium: Activating')
    expect(out).not.toContain('Connecting to Codeium server')
    expect(out).not.toContain('Telemetry is disabled')
  })

  it('keeps actual output (lines not matching any rule)', () => {
    const out = apply(windsurfFilter, _WINDSURF_STARTUP_VERBOSE, argv)
    expect(out).toContain('Cascade is ready.')
    expect(out).toContain('Your workspace has 127 Python files.')
  })

  it('counts cascade tool-call lines as note', () => {
    const out = apply(windsurfFilter, _WINDSURF_STARTUP_VERBOSE, argv)
    expect(out).toContain('[token-goat:')
    expect(out.toLowerCase()).toContain('cascade tool-call')
  })

  it('emits context note from last context line', () => {
    const out = apply(windsurfFilter, _WINDSURF_STARTUP_VERBOSE, argv)
    expect(out.toLowerCase()).toContain('context')
  })

  it('emits startup/activation noise note', () => {
    const out = apply(windsurfFilter, _WINDSURF_STARTUP_VERBOSE, argv)
    expect(out.toLowerCase()).toContain('startup/activation')
  })
})

// ---------------------------------------------------------------------------
// OpenCodeFilter — dispatch + compression
// ---------------------------------------------------------------------------

describe('OpenCodeFilter dispatch', () => {
  it('matches opencode binary', () => {
    expect(openCodeFilter.matches(['opencode'])).toBe(true)
  })

  it('selectFilter routes opencode to openCodeFilter', () => {
    const f = selectFilter(['opencode'])
    expect(f?.name).toBe('opencode')
  })
})

const _OPENCODE_VERBOSE = [
  'OpenCode v0.1.2',
  'Provider: anthropic',
  'Model: claude-3-5-sonnet',
  'Mode: auto',
  'Context: 5000/200000',
  '⠋',
  '→ readFile(src/main.py)',
  '← readFile (1234 chars)',
  '→ writeFile(src/main.py)',
  '← writeFile (567 chars)',
  '',
  'The code has been updated successfully.',
  '',
  'Session saved to /tmp/session.json',
].join('\n')

describe('OpenCodeFilter compression', () => {
  const argv = ['opencode']

  it('drops banner, mode, spinner, and session-save lines', () => {
    const out = apply(openCodeFilter, _OPENCODE_VERBOSE, argv)
    expect(out).not.toContain('OpenCode v0.1.2')
    expect(out).not.toContain('Mode: auto')
    expect(out).not.toContain('⠋')
    expect(out).not.toContain('Session saved to')
  })

  it('appends tool call/result collapse notice', () => {
    const out = apply(openCodeFilter, _OPENCODE_VERBOSE, argv)
    expect(out).toContain('[token-goat: 4 tool call/result line(s) collapsed')
    // appended after kept body
    const noteIdx = out.lastIndexOf('[token-goat: 4 tool call')
    const bodyIdx = out.indexOf('The code has been updated successfully.')
    expect(noteIdx).toBeGreaterThan(bodyIdx)
  })

  it('keeps the response body', () => {
    const out = apply(openCodeFilter, _OPENCODE_VERBOSE, argv)
    expect(out).toContain('The code has been updated successfully.')
  })

  it('emits provider, model, and context notes', () => {
    const out = apply(openCodeFilter, _OPENCODE_VERBOSE, argv)
    expect(out.toLowerCase()).toContain('provider')
    expect(out.toLowerCase()).toContain('model')
    expect(out.toLowerCase()).toContain('context')
  })
})

// ---------------------------------------------------------------------------
// ContinueFilter — dispatch + compression
// ---------------------------------------------------------------------------

describe('ContinueFilter dispatch', () => {
  it('matches continue binary', () => {
    expect(continueFilter.matches(['continue'])).toBe(true)
  })

  it('selectFilter routes continue to continueFilter', () => {
    const f = selectFilter(['continue'])
    expect(f?.name).toBe('continue')
  })
})

const _CONTINUE_VERBOSE = [
  'Continue.dev v0.9.45',
  'Loading model: claude-3-5-sonnet',
  'Config loaded from ~/.continue/config.json',
  'Indexing: 1/100 files',
  'Indexing: 50/100 files',
  'Indexing: 100/100 files',
  'Tokens: 1234 prompt, 567 completion',
  '',
  'Here is the answer to your question.',
].join('\n')

describe('ContinueFilter compression', () => {
  const argv = ['continue']

  it('drops banner, model-load, and config lines', () => {
    const out = apply(continueFilter, _CONTINUE_VERBOSE, argv)
    expect(out).not.toContain('Continue.dev v0.9.45')
    expect(out).not.toContain('Loading model:')
    expect(out).not.toContain('Config loaded')
  })

  it('appends indexing collapse notice with last line', () => {
    const out = apply(continueFilter, _CONTINUE_VERBOSE, argv)
    expect(out).toContain('[token-goat: 3 indexing progress line(s) collapsed')
    expect(out).toContain('last: Indexing: 100/100 files')
  })

  it('keeps the response body', () => {
    const out = apply(continueFilter, _CONTINUE_VERBOSE, argv)
    expect(out).toContain('Here is the answer to your question.')
  })

  it('emits tokens note', () => {
    const out = apply(continueFilter, _CONTINUE_VERBOSE, argv)
    expect(out.toLowerCase()).toContain('tokens')
  })
})

// ---------------------------------------------------------------------------
// ClineFilter — dispatch + compression (incl. alwaysKeepRe)
// ---------------------------------------------------------------------------

describe('ClineFilter dispatch', () => {
  it('matches cline binary', () => {
    expect(clineFilter.matches(['cline'])).toBe(true)
  })

  it('matches claude-dev binary', () => {
    expect(clineFilter.matches(['claude-dev'])).toBe(true)
  })

  it('selectFilter routes cline to clineFilter', () => {
    const f = selectFilter(['cline'])
    expect(f?.name).toBe('cline')
  })
})

const _CLINE_SESSION = [
  'Cline v3.1.0',
  'Initializing Cline...',
  'Loading workspace',
  'MCP Server "sqlite" connected',
  'Thinking...',
  'Cline wants to execute: npm test',
  'Reading file: src/main.py...',
  'Reading file: src/test.py...',
  'Reading file: src/utils.py...',
  'Tokens: 5000 (prompt), 500 (completion)',
  'API Cost: $0.0321',
  'Context Window: 50000/200000 tokens',
].join('\n')

describe('ClineFilter compression', () => {
  const argv = ['cline']

  it('drops banner, spinner, startup, and MCP status lines', () => {
    const out = apply(clineFilter, _CLINE_SESSION, argv)
    expect(out).not.toContain('Cline v3.1.0')
    expect(out).not.toContain('Initializing Cline')
    expect(out).not.toContain('Loading workspace')
    expect(out).not.toContain('MCP Server')
    expect(out).not.toContain('Thinking...')
  })

  it('always keeps "wants to execute" lines before drop rules fire', () => {
    const out = apply(clineFilter, _CLINE_SESSION, argv)
    expect(out).toContain('Cline wants to execute: npm test')
  })

  it('appends file-read collapse notice', () => {
    const out = apply(clineFilter, _CLINE_SESSION, argv)
    expect(out).toContain('[token-goat: 3 file-read progress line(s) collapsed')
  })

  it('emits tokens, cost, and context notes', () => {
    const out = apply(clineFilter, _CLINE_SESSION, argv)
    expect(out.toLowerCase()).toContain('tokens')
    expect(out.toLowerCase()).toContain('cost')
    expect(out.toLowerCase()).toContain('context')
  })
})

// ---------------------------------------------------------------------------
// CodexExecFilter — dispatch + compression
// ---------------------------------------------------------------------------

describe('CodexExecFilter dispatch', () => {
  it('is an instance of CodexExecFilter class', () => {
    expect(codexExecFilter).toBeInstanceOf(CodexExecFilter)
  })

  it('matches codex binary', () => {
    expect(codexExecFilter.matches(['codex'])).toBe(true)
  })

  it('matches codex exec with a prompt', () => {
    expect(codexExecFilter.matches(['codex', 'exec', 'some prompt'])).toBe(true)
  })

  it('matches codex with flags', () => {
    expect(codexExecFilter.matches(['codex', '--help'])).toBe(true)
  })

  it('does not match conda', () => {
    expect(codexExecFilter.matches(['conda'])).toBe(false)
  })

  it('does not match other binaries', () => {
    expect(codexExecFilter.matches(['gh'])).toBe(false)
    expect(codexExecFilter.matches(['aider'])).toBe(false)
    expect(codexExecFilter.matches([])).toBe(false)
  })

  it('selectFilter routes codex to codexExecFilter', () => {
    const f = selectFilter(['codex', 'exec', 'some prompt'])
    expect(f?.name).toBe('codex-exec')
  })
})

// ---------------------------------------------------------------------------
// CodexExecFilter — compression (structural algorithm)
// ---------------------------------------------------------------------------

const _CODEX_TRANSCRIPT = [
  'OpenAI Codex v1.0.0',
  '--------',
  'model: gpt-4o',
  'temperature: 0.5',
  '--------',
  'user',
  'What is 2+2?',
  'codex',
  'The answer is 4.',
  'tokens used',
  '12',
].join('\n')

describe('CodexExecFilter compression', () => {
  const argv = ['codex', 'exec', 'What is 2+2?']

  it('extracts model and token count into summary header', () => {
    const out = apply(codexExecFilter, _CODEX_TRANSCRIPT, argv)
    expect(out).toContain('[codex: model=gpt-4o, tokens=12]')
  })

  it('extracts the last codex role answer', () => {
    const out = apply(codexExecFilter, _CODEX_TRANSCRIPT, argv)
    expect(out).toContain('The answer is 4.')
  })

  it('omits transcript header, separator lines, and role labels', () => {
    const out = apply(codexExecFilter, _CODEX_TRANSCRIPT, argv)
    expect(out).not.toContain('OpenAI Codex v1.0.0')
    expect(out).not.toContain('--------')
    expect(out).not.toContain('temperature:')
    expect(out).not.toContain('tokens used')
    expect(out).not.toContain('12\n')
  })

  it('passes through unrecognised format without modification', () => {
    // No separator lines → passthrough
    const plain = 'Some output without separators.\nAnother line.\n'
    const out = apply(codexExecFilter, plain, argv)
    expect(out).toContain('Some output without separators.')
    expect(out).toContain('Another line.')
  })

  it('handles multi-turn transcript (uses last codex role)', () => {
    const multiTurn = [
      'OpenAI Codex v1.0.0',
      '--------',
      'model: gpt-4o',
      '--------',
      'user',
      'Question 1',
      'codex',
      'Answer 1',
      'user',
      'Question 2',
      'codex',
      'Answer 2 — this is the final answer',
      'tokens used',
      '42',
    ].join('\n')
    const out = apply(codexExecFilter, multiTurn, argv)
    expect(out).toContain('[codex: model=gpt-4o, tokens=42, 1 earlier turn(s) dropped]')
    expect(out).toContain('Answer 2 — this is the final answer')
    expect(out).not.toContain('Answer 1')
  })
})

// Transcripts below are literal captures from codex-cli 0.148.0 (only the workdir path is rewritten to avoid backslash escapes). codex exec echoes the final agent message verbatim after the 'tokens used' footer.
const _CODEX_REAL_HEADER = [
  'Reading additional input from stdin...',
  'OpenAI Codex v0.148.0',
  '--------',
  'workdir: /tmp/codexprobe',
  'model: gpt-5.6-terra',
  'provider: openai',
  'approval: never',
  'sandbox: read-only',
  'reasoning effort: high',
  'reasoning summaries: none',
  'session id: 01a0438e-eed2-7371-bf08-5e673e6196d5',
  '--------',
]

describe('CodexExecFilter compression on real codex-cli 0.148.0 output', () => {
  const argv = ['codex', 'exec', 'prompt']

  it('keeps a multi-line answer whole and reads the real token count instead of leaking the footer', () => {
    const answer = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
    const transcript = [
      ..._CODEX_REAL_HEADER,
      'user',
      'Output exactly the numbers 1 through 10, one per line, nothing else.',
      'codex',
      ...answer,
      'tokens used',
      '5,285',
      ...answer,
    ].join('\n')
    const out = apply(codexExecFilter, transcript, argv)
    expect(out.trimEnd().split('\n')).toEqual(['[codex: model=gpt-5.6-terra, tokens=5,285]', ...answer])
  })

  it('does not truncate an answer body that contains a bare codex line', () => {
    const answer = ['alpha', 'codex', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
    const transcript = [
      ..._CODEX_REAL_HEADER,
      'user',
      'Output the first nine letters of the Greek alphabet but replace the second with the single word codex.',
      'codex',
      ...answer,
      'tokens used',
      '5,279',
      ...answer,
    ].join('\n')
    const out = apply(codexExecFilter, transcript, argv)
    expect(out.trimEnd().split('\n')).toEqual(['[codex: model=gpt-5.6-terra, tokens=5,279]', ...answer])
  })

  it('anchors on the real footer, not a tokens used line inside the answer body', () => {
    const answer = [
      'tokens used',
      'is the footer codex exec prints after the transcript, followed by the count.',
      'Everything after that count line is the final message echoed back verbatim.',
    ]
    const transcript = [
      ..._CODEX_REAL_HEADER,
      'user',
      'What does the tokens used line mean?',
      'codex',
      ...answer,
      'tokens used',
      '7,412',
      ...answer,
    ].join('\n')
    const out = apply(codexExecFilter, transcript, argv)
    expect(out.trimEnd().split('\n')).toEqual(['[codex: model=gpt-5.6-terra, tokens=7,412]', ...answer])
  })

  it('says how many earlier turns it dropped when it has to guess at role labels', () => {
    const transcript = [
      ..._CODEX_REAL_HEADER,
      'user',
      'Question 1',
      'codex',
      'Answer 1 padded out so the compressed body clears the net-savings floor comfortably.',
      'user',
      'Question 2',
      'codex',
      'Answer 2 is the final one.',
      'tokens used',
      '4,096',
    ].join('\n')
    const out = apply(codexExecFilter, transcript, argv)
    expect(out.trimEnd().split('\n')).toEqual([
      '[codex: model=gpt-5.6-terra, tokens=4,096, 1 earlier turn(s) dropped]',
      'Answer 2 is the final one.',
    ])
  })
})

// ---------------------------------------------------------------------------
// Dispatch ordering: GhCopilotFilter precedes GhFilter in TOOL_FILTERS
// ---------------------------------------------------------------------------

describe('dispatch ordering: AI_CLI_FILTERS before CI_FILTERS', () => {
  it('gh copilot explain routes to gh-copilot, not gh or gh-run-log', () => {
    const f = selectFilter(['gh', 'copilot', 'explain', 'what does this error mean'])
    expect(f?.name).toBe('gh-copilot')
  })

  it('gh copilot suggest routes to gh-copilot', () => {
    const f = selectFilter(['gh', 'copilot', 'suggest', 'list files'])
    expect(f?.name).toBe('gh-copilot')
  })

  it('gh pr list does not route to gh-copilot (falls through to GhFilter)', () => {
    const f = selectFilter(['gh', 'pr', 'list'])
    expect(f?.name).not.toBe('gh-copilot')
    expect(f?.name).toBe('gh')
  })

  it('gh run view --log routes to gh-run-log, not gh-copilot', () => {
    const f = selectFilter(['gh', 'run', 'view', '123', '--log'])
    expect(f?.name).toBe('gh-run-log')
  })
})

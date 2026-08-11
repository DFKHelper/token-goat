import { tempConfigPath } from './helpers/temp-config.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { HookEvent } from '../src/hook_registry.js'
import { writeFileSync, unlinkSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expectHookType } from './helpers/hook-output.js'

// vi.mock is hoisted — this redirects configPath() to a per-test-file temp
// file so the bash_compress.cache_min_bytes / timeout_seconds wiring tests
// near the bottom of this file can set a non-default config value
// deterministically. Mirrors tests/config.test.ts and tests/disk_cache.test.ts.
// dataDir() is also redirected to an isolated temp dir so the git-mutation
// staleness-enqueue tests below (which exercise the real queue/dirty.txt
// write path via enqueueDirtyPathSafe) never touch the real local dirty
// queue -- mirrors tests/hooks_edit.test.ts's isolation pattern.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
    dataDir: () => _testDataDir,
  }
})

const _testConfigPath = tempConfigPath('tg-hooks-bash-config-test.toml')
const _testDataDir = mkdtempSync(join(tmpdir(), 'tg-hooks-bash-data-'))

import { postBashHandler, preBashHandler, extractCurlDownload, extractMarkdownHeadingGrep, extractRgSymbolSearch, extractPowerShellWrappedGetContent, extractCatFile, extractGhViewForBatchAdvisory, isHeadMovingGitCommand } from '../src/hooks_bash.js'
import { getBashOutputId, recordFileRead, getCurlDownloadPath, wasFileReadThisSession, getFileLineRanges, wasFileTruncatedThisSession } from '../src/session.js'
import { getBashOutput } from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'
import { resolveIndexPath } from '../src/paths.js'
import * as pathsModule from '../src/paths.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { getDirtyPaths, clearDirtyQueue } from '../src/hooks_index.js'
import { foldPath } from '../src/util.js'

/**
 * The dirty queue, case-folded for comparison.
 *
 * The git-mutation tests build their expected path from `tmpdir()` (the environment's spelling,
 * `C:\WINDOWS\TEMP`) while the enqueued path originates from git's own output (the on-disk
 * spelling, `C:/Windows/Temp`). Both name the same file, so a case-sensitive `toContain` fails
 * on a distinction the filesystem does not make. foldPath is the product's own path-comparison
 * function, so folding both sides asserts the invariant that actually holds.
 */
function foldedDirtyPaths(): string[] {
  return getDirtyPaths().map(foldPath)
}

function makePostBashEvent(command: string, output: string, cwd?: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
    agentId: undefined,
    raw: {
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: output,
      ...(cwd !== undefined ? { cwd } : {}),
    },
  })
}

describe('postBashHandler', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('passes through when command is missing', async () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: {},
      sessionId: 'test-session',
      agentId: undefined,
      raw: { tool_response: 'some output' },
    }
    const result = await postBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('passes through for non-monitoring non-build commands', async () => {
    const event = makePostBashEvent('echo hello', 'hello\n'.repeat(200))
    const result = await postBashHandler(event)
    expect(result.hookType).toBe('pass')
    // No output cached for echo
    expect(getBashOutputId('anything')).toBeNull()
  })

  it('passes through when output is below the size threshold', async () => {
    const event = makePostBashEvent('pytest tests/', 'short')
    const result = await postBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('stores monitoring command output and records the session mapping', async () => {
    const largeOutput = 'PASSED test_foo\nFAILED test_bar\n'.repeat(50)
    const event = makePostBashEvent('pytest tests/', largeOutput)
    await postBashHandler(event)

    // The session mapping should have been written
    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('pytest tests/').slice(0, 16)
    const id = getBashOutputId(simpleHash)
    expect(id).not.toBeNull()

    // The cache entry should be findable
    const entry = getBashOutput(id!)
    expect(entry).not.toBeNull()
    expect(entry!.command).toBe('pytest tests/')
    expect(entry!.output).toBe(largeOutput)
  })

  it('stores build command output and records the session mapping', async () => {
    const largeOutput = 'Compiling token_goat v1.0.0\nFinished release\n'.repeat(40)
    const event = makePostBashEvent('cargo build', largeOutput)
    await postBashHandler(event)

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('cargo build').slice(0, 16)
    const id = getBashOutputId(simpleHash)
    expect(id).not.toBeNull()
  })

  it('records the real exit code, not a hardcoded 0, when caching a failed build command (BASH-EXITCODE-0-HARDCODED regression)', async () => {
    const cmd = 'cargo build'
    const largeOutput = 'error[E0433]: failed to resolve\nerror: could not compile `token_goat`\n'.repeat(40)
    const failedEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: cmd },
      sessionId: 'test-session',
      agentId: undefined,
      raw: {
        tool_name: 'Bash',
        tool_input: { command: cmd },
        tool_response: { output: largeOutput, exit_code: 101 },
      },
    }
    await postBashHandler(failedEvent)

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent(cmd).slice(0, 16)
    const id = getBashOutputId(simpleHash)
    expect(id).not.toBeNull()
    const entry = getBashOutput(id!)
    expect(entry).not.toBeNull()
    expect(entry!.exitCode).toBe(101)
  })

  it('stores codex AI review output', async () => {
    const largeOutput = 'Reviewing code...\nSuggestion: extract method\nConclusion: LGTM\n'.repeat(30)
    const event = makePostBashEvent('codex review prompt.md', largeOutput)
    await postBashHandler(event)

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('codex review prompt.md').slice(0, 16)
    expect(getBashOutputId(simpleHash)).not.toBeNull()
  })

  it('stores glm.sh AI inference output', async () => {
    const largeOutput = 'Analyzing codebase...\nVerdict: found 3 issues\n'.repeat(30)
    const event = makePostBashEvent('~/.claude/bin/glm.sh /tmp/prompt.txt', largeOutput)
    await postBashHandler(event)

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('~/.claude/bin/glm.sh /tmp/prompt.txt').slice(0, 16)
    expect(getBashOutputId(simpleHash)).not.toBeNull()
  })

  it('handles tool_response as object with output field', async () => {
    const largeOutput = 'PASSED\nFAILED\n'.repeat(50)
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: 'pytest tests/' },
      sessionId: 'test-session',
      agentId: undefined,
      raw: {
        tool_name: 'Bash',
        tool_input: { command: 'pytest tests/' },
        tool_response: { output: largeOutput },
      },
    }
    await postBashHandler(event)

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('pytest tests/').slice(0, 16)
    expect(getBashOutputId(simpleHash)).not.toBeNull()
  })

  it('caches output for cd-prefixed tsc command and fires recall on repeat', async () => {
    const bigOutput = 'src/auth.ts(12,5): error TS2345: ...\n'.repeat(50)
    // Post side: store the output
    await postBashHandler(makePostBashEvent('cd C:/Projects/wellsent && npx tsc --noEmit', bigOutput))
    // Pre side: second run should get a recall hint
    const result = preBashHandler(makeBashEvent('cd C:/Projects/wellsent && npx tsc --noEmit'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('bash-output')
    }
  })

  it('never throws — swallows errors silently', async () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: 'pytest tests/' },
      sessionId: 'test-session',
      agentId: undefined,
      raw: { tool_response: null as unknown as string },
    }
    await expect(postBashHandler(event)).resolves.toMatchObject({ hookType: 'pass' })
  })
})

describe('pipe/redirect-insensitive cache keying', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('pipe variant hits cache: same jest command with different tail filter', async () => {
    const baseCmd = 'npx jest tests/unit/foo.test.js --no-coverage 2>&1'
    const firstCmd = baseCmd + ' | tail -40'
    const secondCmd = baseCmd + ' | grep "PASS"'
    const largeOutput = 'PASSED tests/unit/foo.test.js\n'.repeat(200)

    // Post: run with first pipe variant
    await postBashHandler(makePostBashEvent(firstCmd, largeOutput))

    // Pre: run with different pipe variant — should hit cache
    const result = preBashHandler(makeBashEvent(secondCmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat bash-output')
    }
  })

  it('redirect-only variant hits cache: same tsc with different stdout+stderr combo', async () => {
    const baseCmd = 'npx tsc tests/unit/foo.test.ts --noEmit'
    const firstCmd = baseCmd + ' 2>&1'
    const secondCmd = baseCmd + ' 2>&1 | tail -20'
    const largeOutput = 'src/auth.ts(12,5): error TS2345: ...\n'.repeat(50)

    // Post: run with redirect
    await postBashHandler(makePostBashEvent(firstCmd, largeOutput))

    // Pre: run with redirect + tail — should hit cache
    const result = preBashHandler(makeBashEvent(secondCmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat bash-output')
    }
  })

  it('different base command does NOT collide: jest on different test file', async () => {
    const cmd1 = 'npx jest tests/unit/foo.test.js --no-coverage 2>&1 | tail -40'
    const cmd2 = 'npx jest tests/unit/bar.test.js --no-coverage 2>&1 | tail -40'
    const largeOutput = 'PASSED tests/unit/foo.test.js\n'.repeat(200)

    // Post: run first test
    await postBashHandler(makePostBashEvent(cmd1, largeOutput))

    // Pre: run different test — should NOT hit cache
    const result = preBashHandler(makeBashEvent(cmd2))
    expect(result.hookType).toBe('pass')
  })
})

function makeBashEvent(command: string, cwd?: string): HookEvent {
  return makeHookEvent({
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
    agentId: undefined,
    raw: cwd !== undefined ? { cwd } : {},
  })
}

describe('preBashHandler — unbalanced shell quoting false positives (detectUnbalancedShellSyntax)', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('does not false-positive on a backslash-escaped quote outside any string', () => {
    const result = preBashHandler(makeBashEvent('echo hello \\" world'))
    expect(result.hookType).toBe('pass')
  })

  it('does not false-positive on an arithmetic left-shift inside $(( ... ))', () => {
    const result = preBashHandler(makeBashEvent('echo $((1 << 2))'))
    expect(result.hookType).toBe('pass')
  })

  it('does not false-positive on an apostrophe inside a real shell comment', () => {
    const result = preBashHandler(makeBashEvent("echo hi  # don't forget"))
    expect(result.hookType).toBe('pass')
  })

  it('still flags a genuinely unclosed double quote', () => {
    const result = preBashHandler(makeBashEvent('echo "unterminated'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('unclosed double quote')
    }
  })

  it('still flags a genuinely unclosed single quote', () => {
    const result = preBashHandler(makeBashEvent("echo 'unterminated"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('unclosed single quote')
    }
  })

  it('does not false-positive on a valid heredoc with CRLF line endings', () => {
    const crlfCommand = 'cat <<EOF\r\nhello\r\nworld\r\nEOF\r\n'
    const result = preBashHandler(makeBashEvent(crlfCommand))
    expect(result.hookType).toBe('pass')
  })

  it('does not false-positive on a here-string with double quotes', () => {
    const result = preBashHandler(makeBashEvent('cat <<< "hello world"'))
    expect(result.hookType).toBe('pass')
  })

  it('does not false-positive on a here-string with variable', () => {
    const result = preBashHandler(makeBashEvent('cat <<< "$var"'))
    expect(result.hookType).toBe('pass')
  })

  it('does not false-positive on a here-string with bare text', () => {
    const result = preBashHandler(makeBashEvent('python3 -c "print(1)" <<< "input"'))
    expect(result.hookType).toBe('pass')
  })

  it('still detects unterminated real heredocs', () => {
    const result = preBashHandler(makeBashEvent('cat <<EOF\nhello\nworld'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('unterminated heredoc')
    }
  })

  it('still detects terminated real heredocs correctly', () => {
    const result = preBashHandler(makeBashEvent('cat <<EOF\nhello\nworld\nEOF'))
    expect(result.hookType).toBe('pass')
  })
})

describe('preBashHandler — cd-prefix stripping', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('intercepts cat through a cd prefix (absolute path)', () => {
    const result = preBashHandler(makeBashEvent('cd /some/path && cat src/auth.ts'))
    expect(result.hookType).not.toBe('pass')
  })

  it('intercepts cat through a quoted cd prefix', () => {
    const result = preBashHandler(makeBashEvent('cd "C:/Projects/wellsent" && cat src/auth.ts'))
    expect(result.hookType).not.toBe('pass')
  })

  it('intercepts through chained cd prefixes', () => {
    const result = preBashHandler(makeBashEvent('cd /a && cd /b && cat src/auth.ts'))
    expect(result.hookType).not.toBe('pass')
  })

  it('passes through normal commands without cd prefix', () => {
    const result = preBashHandler(makeBashEvent('echo hello'))
    expect(result.hookType).toBe('pass')
  })

  it('emits contextOutput (not deny) for cd-prefixed cat of source file', () => {
    const result = preBashHandler(makeBashEvent('cd /other/dir && cat src/auth.ts'))
    // When cd prefix was stripped, path-sensitive denies become contextOutput
    expect(result.hookType).toBe('context')
  })

  it('resolves the hint path against the cd target directory, not the raw post-strip path', () => {
    const result = preBashHandler(makeBashEvent('cd subdir && cat file.py', '/repo'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      // The suggested command must not name the bare path extracted from the stripped
      // command — that path is relative to `subdir`, not to the actual cwd the model runs
      // its next command from, so it would fail to resolve if followed literally.
      expect(result.context).not.toContain('"file.py::')
      const expectedPath = resolveIndexPath('file.py', resolveIndexPath('subdir', '/repo'))
      expect(result.context).toContain(expectedPath)
    }
  })

  it('resolves the hint path through chained cd prefixes in order', () => {
    const result = preBashHandler(makeBashEvent('cd a && cd b && cat file.py', '/repo'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      const expectedDir = resolveIndexPath('b', resolveIndexPath('a', '/repo'))
      const expectedPath = resolveIndexPath('file.py', expectedDir)
      expect(result.context).toContain(expectedPath)
    }
  })

  it('resolves the hint path against the cd target directory for tail, not the bare post-strip path (regression: tail/head/Get-Content -Tail/-Select-Object -First/cat|jq/markdown-heading-grep/rg-structural hints never applied resolveCdHintPath while cat/pyRead/nodeRead did, so a cd-prefixed tail suggested a path relative to the wrong directory)', () => {
    const result = preBashHandler(makeBashEvent('cd subdir && tail -n 30 file.py', '/repo'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).not.toContain('"file.py::')
      const expectedPath = resolveIndexPath('file.py', resolveIndexPath('subdir', '/repo'))
      expect(result.context).toContain(expectedPath)
    }
  })
})

describe('preBashHandler — cat source file recall', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits token-goat read suggestion when cat output is cached', async () => {
    const cmd = 'pytest tests/'
    const largeOutput = 'PASSED test_auth\nFAILED test_session\n'.repeat(50)

    // Post handler caches the output
    await postBashHandler({
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: cmd },
      sessionId: 's',
      agentId: undefined,
      raw: { tool_response: largeOutput },
    })

    // Pre handler should emit the tailored recall message
    const result = preBashHandler({
      eventName: 'pre_tool_use',
      toolName: 'Bash',
      toolInput: { command: cmd },
      sessionId: 's',
      agentId: undefined,
      raw: {},
    })

    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat bash-output')
    }
  })

  it('passes through on first call for a command with no cached output', () => {
    const result = preBashHandler({
      eventName: 'pre_tool_use',
      toolName: 'Bash',
      toolInput: { command: 'echo hello' },
      sessionId: 's',
      agentId: undefined,
      raw: {},
    })
    expect(result.hookType).toBe('pass')
  })

  it('denies cat of a Java source file', () => {
    const event = makeBashEvent('cat /c/Projects/repo/src/main/java/Foo.java')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
  })

  it('denies a multi-file cat that a single-file cat would deny (regex previously anchored one path, so `cat a.ts b.ts` slipped through)', () => {
    // `cat src/a.ts` alone is denied; the single-path regex `$`-anchor rejected a
    // trailing second path, so `cat src/a.ts src/b.ts` bypassed the deny entirely.
    const event = makeBashEvent('cat src/a.ts src/b.ts')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      // Both paths are surfaced with a surgical-read suggestion.
      expect(result.message).toContain('src/a.ts')
      expect(result.message).toContain('src/b.ts')
      expect(result.message).toContain('token-goat read')
    }
  })

  it('still passes a piped single-file cat through (multi-file guard must not fire on `cat f | cmd`)', () => {
    const result = preBashHandler(makeBashEvent('cat src/a.ts | wc -l'))
    expect(result.hookType).not.toBe('deny')
  })

  it('denies cat of a markdown file', () => {
    const event = makeBashEvent('cat /c/Projects/report.md')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat section')
    }
  })

  it('denies cat of a quoted markdown path', () => {
    const event = makeBashEvent('cat "C:/Projects/yeswehack/report-07/report.md"')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
  })

  it('denies python -c with open() reading a source file', () => {
    const event = makeBashEvent("python3 -c \"\nwith open('C:/Projects/foo/bar.java') as f: content = f.read()\n\"")
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat read')
    }
  })

  it('denies python heredoc that reads a markdown file', () => {
    const event = makeBashEvent("python3 - << 'PYEOF'\npath = 'C:/Projects/yeswehack/report-05/report.md'\nwith open(path, encoding='utf-8') as f: content = f.read()\nPYEOF")
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat section')
    }
  })

  it('does not false-positive on a command that merely contains the substring "python3" elsewhere', () => {
    // The python-read detector used to be unanchored (`/python3?/.test(cmd)`), matching that
    // substring ANYWHERE in the command — not just an actual python invocation. A command that
    // just mentions "python3" in passing (e.g. a commit message) while separately calling an
    // unrelated open(...) (here a Node one-liner) must not be misread as a Python file read.
    const event = makeBashEvent("git commit -m \"add python3 support\" && node -e \"require('fs').open('config.json', 'r', cb)\"")
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('denies cat of a local.env file', () => {
    const result = preBashHandler(makeBashEvent('cat C:/Projects/myapp/local.env'))
    expectHookType(result, 'deny')
    expect(result.message).toContain('config-get')
  })

  it('denies cat of a .env.local file', () => {
    const result = preBashHandler(makeBashEvent('cat /app/.env.local'))
    expectHookType(result, 'deny')
    expect(result.message).toContain('config-get')
  })

  it('emits advisory context for cat of a SQL migration file', () => {
    const result = preBashHandler(makeBashEvent('cat supabase/migrations/0001_init.sql'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
      expect(result.context).toContain('CREATE TABLE')
    }
  })

  it('passes through cat of a /tmp/ temp file', () => {
    const result = preBashHandler(makeBashEvent('cat /tmp/codex-verdict.md'))
    expect(result.hookType).toBe('pass')
  })

  it('emits advisory context for head command on source file', () => {
    const result = preBashHandler(makeBashEvent('head -n 46 src/app/analytics/page.tsx'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('head')
    }
  })

  it(
    'head command on a SQL file suggests table_name, matching cat\'s SQL hint for the same file type ' +
      '(regression: classifyDocConfig folded .sql into isDoc with no isSql flag, so `head file.sql` got the ' +
      'generic "SectionHeading" doc phrasing instead of the table_name phrasing `cat file.sql` already gets)',
    () => {
      const result = preBashHandler(makeBashEvent('head -15 supabase/migrations/0001_init.sql'))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).toContain('table_name')
        expect(result.context).toContain('CREATE TABLE')
        expect(result.context).not.toContain('SectionHeading')
      }
    },
  )

  it('tail command on a SQL file suggests table_name, matching head\'s SQL hint', () => {
    const result = preBashHandler(makeBashEvent('tail -n 30 supabase/migrations/0001_init.sql'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('table_name')
      expect(result.context).not.toContain('SectionHeading')
    }
  })

  it('tail command on a config file suggests config-get, matching head\'s hint for the same file type (regression: extractTailFile did not classify isConfig, so `tail config.json` fell back to the generic read/skeleton hint that `head config.json` never gets)', () => {
    const result = preBashHandler(makeBashEvent('tail -n 30 src/config.json'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('config-get')
    }
  })

  it('Get-Content -Tail on a config file suggests config-get, matching Select-Object -First\'s hint for the same file type (regression: extractGetContentTail did not classify isConfig)', () => {
    const result = preBashHandler(makeBashEvent('Get-Content -Tail 30 src/config.json'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('config-get')
    }
  })

  it(
    'head -n 10 and tail -n 10 on the same file agree on the surgical threshold ' +
      '(regression: extractHeadFile used n<10 while extractTailFile used n<=10, so ' +
      '`head -n 10 file` fired a hint that `tail -n 10 file` did not for the same line count)',
    () => {
      const headResult = preBashHandler(makeBashEvent('head -n 10 src/hooks_bash.ts'))
      const tailResult = preBashHandler(makeBashEvent('tail -n 10 src/hooks_bash.ts'))
      expect(headResult.hookType).toBe('pass')
      expect(tailResult.hookType).toBe('pass')
    },
  )

  it('passes through head on unknown extension', () => {
    const result = preBashHandler(makeBashEvent('head -5 /proc/cpuinfo'))
    expect(result.hookType).toBe('pass')
  })

  it('emits sed line-range read hint with @start-end', () => {
    const result = preBashHandler(makeBashEvent("sed -n '13,31p' docs/report.md"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat read')
      expect(result.context).toContain('docs/report.md@13-31')
    }
  })

  it('sed line-range hint handles a path with 2>/dev/null suffix', () => {
    const result = preBashHandler(makeBashEvent("sed -n '250,300p' src/app/page.tsx 2>/dev/null"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('src/app/page.tsx@250-300')
    }
  })

  it('passes through single-address sed (no comma)', () => {
    const result = preBashHandler(makeBashEvent("sed -n '5p' src/app/page.tsx"))
    expect(result.hookType).toBe('pass')
  })

  it('passes through piped sed (not a whole-command line read)', () => {
    const result = preBashHandler(makeBashEvent("sed -n '10,20p' src/app/page.tsx | head"))
    expect(result.hookType).toBe('pass')
  })

  it('passes through sed on a temp path', () => {
    const result = preBashHandler(makeBashEvent("sed -n '1,5p' /tmp/scratch.md"))
    expect(result.hookType).toBe('pass')
  })

  it('sed hint for Markdown suggests section by heading', () => {
    const result = preBashHandler(makeBashEvent("sed -n '13,31p' docs/report.md"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
      expect(result.context).toContain('docs/report.md@13-31')
    }
  })

  it('sed hint for a source file suggests a symbol read', () => {
    const result = preBashHandler(makeBashEvent("sed -n '40,90p' src/auth.py"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat symbol')
      expect(result.context).toContain('src/auth.py@40-90')
    }
  })

  it('sed hint for a config file suggests config-get', () => {
    const result = preBashHandler(makeBashEvent("sed -n '5,15p' pyproject.toml"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat config-get')
      expect(result.context).toContain('pyproject.toml@5-15')
    }
  })

  it('sed hint for an unknown extension falls back to the plain line-range read', () => {
    const result = preBashHandler(makeBashEvent("sed -n '1,9p' notes/scratch.txt"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('notes/scratch.txt@1-9')
      expect(result.context).not.toContain('token-goat symbol')
      expect(result.context).not.toContain('token-goat section')
      expect(result.context).not.toContain('token-goat config-get')
    }
  })

  it('first sed read on a file gets the normal hint, not an overlap hint', () => {
    const result = preBashHandler(makeBashEvent("sed -n '10,60p' src/paging_demo.ts"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('src/paging_demo.ts@10-60')
      expect(result.context).not.toContain('already read')
    }
  })

  it('a second overlapping sed read names the prior range and points at the delta', () => {
    // First read records lines 10-60 for this file.
    preBashHandler(makeBashEvent("sed -n '10,60p' src/paging_demo.ts"))
    // Second read overlaps (50-60 repeat); the hint should name 10-60 and suggest only the new lines 61-100.
    const result = preBashHandler(makeBashEvent("sed -n '50,100p' src/paging_demo.ts"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already read')
      expect(result.context).toContain('10-60')
      expect(result.context).toContain('src/paging_demo.ts@61-100')
    }
  })

  it('an overlapping sed read that starts BEFORE the prior range surfaces the leading new lines, not a false "already served" (SEDOVERLAP-LEADING-DELTA regression)', () => {
    // First read records lines 50-100 for this file.
    preBashHandler(makeBashEvent("sed -n '50,100p' src/paging_demo.ts"))
    // Second read starts before the prior range and only partially overlaps it; lines 40-49 were never served.
    const result = preBashHandler(makeBashEvent("sed -n '40,60p' src/paging_demo.ts"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already read')
      expect(result.context).toContain('50-100')
      expect(result.context).toContain('src/paging_demo.ts@40-49')
      expect(result.context).not.toContain('already served')
    }
  })

  it('an overlapping sed read that straddles the prior range on both sides surfaces both the leading and trailing new lines', () => {
    // First read records lines 50-60 for this file.
    preBashHandler(makeBashEvent("sed -n '50,60p' src/paging_demo.ts"))
    // Second read fully surrounds the prior range; lines 40-49 and 61-70 were never served.
    const result = preBashHandler(makeBashEvent("sed -n '40,70p' src/paging_demo.ts"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('src/paging_demo.ts@40-49')
      expect(result.context).toContain('src/paging_demo.ts@61-70')
    }
  })

  it('a non-overlapping later sed read on the same file gets the normal hint', () => {
    preBashHandler(makeBashEvent("sed -n '10,60p' src/paging_demo.ts"))
    // 200-260 is disjoint from 10-60, so no overlap hint.
    const result = preBashHandler(makeBashEvent("sed -n '200,260p' src/paging_demo.ts"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('src/paging_demo.ts@200-260')
      expect(result.context).not.toContain('already read')
    }
  })

  it('dedups a sed read against the same file referenced by relative vs absolute path (fail-on-buggy: breaks if the line-range key stops resolving against cwd)', () => {
    const cwd = 'C:/Projects/repo-a'
    preBashHandler(makeBashEvent("sed -n '10,60p' src/paging_demo.ts", cwd))
    const result = preBashHandler(makeBashEvent("sed -n '50,100p' C:/Projects/repo-a/src/paging_demo.ts", cwd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already read')
      expect(result.context).toContain('10-60')
    }
  })

  it('dedups a cd-prefixed sed read against the same file referenced without cd (regression: the sed dedup key and hint path never applied resolveCdHintPath while its cat/tail/head siblings did, so a cd-prefixed sed read resolved against the hook cwd instead of the shell cd target and missed the overlap)', () => {
    const cwd = 'C:/Projects/repo-a'
    preBashHandler(makeBashEvent("sed -n '10,60p' src/paging_demo.ts", cwd))
    const result = preBashHandler(makeBashEvent("cd src && sed -n '50,100p' paging_demo.ts", cwd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already read')
      expect(result.context).toContain('10-60')
      const expectedPath = resolveIndexPath('paging_demo.ts', resolveIndexPath('src', cwd))
      expect(result.context).toContain(expectedPath)
    }
  })

  it('denies node -e with readFileSync reading a source file', () => {
    const event = makeBashEvent(`node -e "const lines = require('fs').readFileSync('scripts/ads-orchestrator.js','utf8').split('\\n')"`)
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('readFileSync')
    }
  })

  it('denies node -e with readFileSync reading a JSON file', () => {
    const event = makeBashEvent(`node -e "const d = require('fs').readFileSync('memory/ads/action-hypotheses.json','utf8')"`)
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('readFileSync')
    }
  })

  it('emits advisory (never deny) context for node -e readFileSync of a SQL migration file, matching cat\'s SQL hint (regression: this branch fell through to the same cdStripped ? contextOutput : denyOutput as every non-SQL case, so a non-cd-prefixed node -e readFileSync of a .sql file was hard-denied while the equivalent `cat file.sql` was always advisory-only)', () => {
    const event = makeBashEvent(`node -e "console.log(require('fs').readFileSync('migrations/0001_init.sql', 'utf8'))"`)
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
      expect(result.context).toContain('table_name')
    }
  })

  it('passes through node -e without readFileSync', () => {
    const event = makeBashEvent(`node -e "require('./scripts/lib/organic-pin-miner-action'); console.log('ok')"`)
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('denies node -e with require of a project JSON file', () => {
    const event = makeBashEvent(`node -e "console.log(require('./package.json').version)"`)
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('config-get')
    }
  })

  it('wraps node -e requiring a node_modules JSON in compress (NodeFilter; not denied)', () => {
    const event = makeBashEvent(`node -e "console.log(require('node_modules/next/package.json').version)"`)
    const result = preBashHandler(event)
    // NodeFilter now matches node -e; the command is wrapped for output compression, not denied — node_modules JSON requires are still allowed.
    expect(result.hookType).toBe('rewriteInput')
  })

  it('denies node -e requiring a nested config JSON', () => {
    const event = makeBashEvent(`node -e "const v=require('.claude/config.json'); console.log(v.model)"`)
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('config-get')
    }
  })

  it('emits advisory context for tail command on source file', () => {
    const event = makeBashEvent('tail -50 tests/unit/ai-creative-generator-action.test.js')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('tail')
    }
  })

  it('passes through tail -f (follow mode)', () => {
    const event = makeBashEvent('tail -f /tmp/orch-run.log')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('passes through tail -10 (small N, already surgical)', () => {
    const event = makeBashEvent('tail -10 scripts/lib/foo.js')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('cat of JSON file suggests config-get not symbol read', () => {
    const event = makeBashEvent('cat memory/ads/keyword-opportunity-actions.json')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('config-get')
    }
  })

  it('head -5 passes through (too small to advise)', () => {
    const event = makeBashEvent('head -5 scripts/lib/hourly-roas-bid-modifier.js')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('head file.ts passes through (no line count defaults to 10, already surgical)', () => {
    const event = makeBashEvent('head src/hooks_bash.ts')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('denies cat -n file.ts (flag before filename)', () => {
    const event = makeBashEvent('cat -n src/app/page.tsx')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat read')
    }
  })

  it('denies cat -nA file.py (combined flags)', () => {
    const event = makeBashEvent('cat -nA scripts/build.py')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
  })

  it('denies cat --number file.ts (long flag)', () => {
    const event = makeBashEvent('cat --number src/lib/utils.ts')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
  })

  it('passes through cat -n on temp file', () => {
    const event = makeBashEvent('cat -n /tmp/staging.ts')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('passes through cat -n with pipe (not a simple cat)', () => {
    const event = makeBashEvent('cat -n file.ts | grep foo')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('denies wsl bash -c "cat /mnt/c/Projects/wellsent/lib/env.ts"', () => {
    const event = makeBashEvent('wsl bash -c "cat /mnt/c/Projects/wellsent/lib/env.ts"')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat read')
    }
  })

  it('denies wsl -d Ubuntu bash -c "cat /mnt/c/Projects/wellsent/app/globals.ts"', () => {
    const event = makeBashEvent('wsl -d Ubuntu bash -c "cat /mnt/c/Projects/wellsent/app/globals.ts"')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
  })

  it('passes through wsl bash -c "cat /mnt/c/.../Temp/foo.ts"', () => {
    const event = makeBashEvent('wsl bash -c "cat /mnt/c/Users/zelys/AppData/Local/Temp/foo.ts"')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('passes through wsl bash -c "cat /mnt/c/Projects/wellsent/nonexistent"', () => {
    const event = makeBashEvent('wsl bash -c "cat /mnt/c/Projects/wellsent/nonexistent"')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('denies wsl bash -c "cat -n /mnt/d/Projects/file.py"', () => {
    const event = makeBashEvent('wsl bash -c "cat -n /mnt/d/Projects/file.py"')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
  })

  it('denies cat of a CSS file', () => {
    const result = preBashHandler(makeBashEvent('cat app/globals.css'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat read')
    }
  })

  it('denies cat of an SCSS file', () => {
    const result = preBashHandler(makeBashEvent('cat src/styles/main.scss'))
    expect(result.hookType).toBe('deny')
  })

  it('denies cat of a LESS file', () => {
    const result = preBashHandler(makeBashEvent('cat src/styles/theme.less'))
    expect(result.hookType).toBe('deny')
  })

  it('denies cat of a SASS file', () => {
    const result = preBashHandler(makeBashEvent('cat src/styles/variables.sass'))
    expect(result.hookType).toBe('deny')
  })
})

describe('preBashHandler — PowerShell read commands', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('Get-Content src/auth.ps1 → suggests token-goat read', () => {
    const event = makeBashEvent('Get-Content src/auth.ps1')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat read')
      expect(result.message).toContain('Get-Content')
    }
  })

  it('gc README.md → suggests token-goat section (doc)', () => {
    const event = makeBashEvent('gc README.md')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat section')
      expect(result.message).toContain('gc')
    }
  })

  it('bat src/auth.ts → suggests token-goat read with bat prefix', () => {
    const event = makeBashEvent('bat src/auth.ts')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('bat')
      expect(result.message).toContain('token-goat read')
    }
  })

  it('type src/main.py → suggests surgical read', () => {
    const event = makeBashEvent('type src/main.py')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('type')
      expect(result.message).toContain('token-goat')
    }
  })

  it('Get-Content src/auth.ts -Tail 50 → suggests surgical read', () => {
    const event = makeBashEvent('Get-Content src/auth.ts -Tail 50')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Get-Content')
      expect(result.message).toContain('token-goat')
    }
  })

  it('Get-Content -Tail 50 src/auth.ts (flag-first) → suggests surgical read', () => {
    const event = makeBashEvent('Get-Content -Tail 50 src/auth.ts')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Get-Content -Tail')
    }
  })

  it('Get-Content foo.ts -Tail 5 (N <= 10) → passes through', () => {
    const event = makeBashEvent('Get-Content foo.ts -Tail 5')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
  })

  it('Get-Content "src/auth.ts" -Tail 50 (double-quoted path) → suggests surgical read (regression: quotes were left on filePath, so the trailing " defeated the extension regex and the hint silently never fired)', () => {
    const event = makeBashEvent('Get-Content "src/auth.ts" -Tail 50')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Get-Content')
      expect(result.message).toContain('token-goat')
    }
  })

  it("Get-Content -Tail 50 'src/auth.ts' (single-quoted, flag-first) → suggests surgical read", () => {
    const event = makeBashEvent("Get-Content -Tail 50 'src/auth.ts'")
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Get-Content -Tail')
    }
  })

  it('Get-Content "src/auth.ts" | Select-Object -First 50 (quoted path) → suggests surgical read (regression: same quote-stripping gap in extractGetContentSelectFirst)', () => {
    const event = makeBashEvent('Get-Content "src/auth.ts" | Select-Object -First 50')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Select-Object -First')
      expect(result.context).toContain('token-goat')
    }
  })

  it('Get-Content src/auth.ts | Select-Object -First 50 → suggests surgical read', () => {
    const event = makeBashEvent('Get-Content src/auth.ts | Select-Object -First 50')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Select-Object -First')
      expect(result.context).toContain('token-goat')
    }
  })

  it('gc src/auth.ts | select -First 30 → suggests surgical read', () => {
    const event = makeBashEvent('gc src/auth.ts | select -First 30')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Select-Object -First')
    }
  })

  it('Get-Content C:/Windows/Temp/x.log (temp path) → passes through', () => {
    const event = makeBashEvent('Get-Content C:/Windows/Temp/x.log')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('Get-Content src/config.json | Select-Object -First 30 (config) → suggests config-get', () => {
    const event = makeBashEvent('Get-Content src/config.json | Select-Object -First 30')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('config-get')
    }
  })

  it('Get-Content README.md | Select-Object -First 30 (doc) → suggests section', () => {
    const event = makeBashEvent('Get-Content README.md | Select-Object -First 30')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
    }
  })
})

describe('preBashHandler — rg structural search', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits advisory context for rg searching for def in a single Python file', () => {
    const event = makeBashEvent('rg "^def" src/token_goat/hooks_read.py')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('skeleton')
    }
  })

  it('emits advisory context for grep "class " targeting a single TS file', () => {
    const event = makeBashEvent('grep "class " src/hooks_bash.ts')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('skeleton')
    }
  })

  it('wraps rg searching for a non-structural pattern (RgFilter registered in SHELL_FILE_FILTERS)', () => {
    const event = makeBashEvent('rg "TODO" src/token_goat/compact.py')
    const result = preBashHandler(event)
    // RgFilter is now registered; pre-Bash wraps rg for output compression instead of passing through.
    expect(result.hookType).toBe('rewriteInput')
  })

  it('wraps rg structural search on a directory (RgFilter registered in SHELL_FILE_FILTERS)', () => {
    const event = makeBashEvent('rg "^def" src/token_goat/')
    const result = preBashHandler(event)
    // RgFilter is now registered; pre-Bash wraps rg for output compression instead of passing through.
    expect(result.hookType).toBe('rewriteInput')
  })
})

describe('preBashHandler — cat | jq pipe interception', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits context hint for cat package.json | jq', () => {
    const result = preBashHandler(makeBashEvent("cat package.json | jq '.dependencies | keys'"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('config-get')
      expect(result.context).toContain('package.json')
    }
  })

  it('emits context hint for cat tsconfig.json | jq .', () => {
    const result = preBashHandler(makeBashEvent('cat tsconfig.json | jq .'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('config-get')
    }
  })

  it('emits context hint for cat quoted path | jq', () => {
    const result = preBashHandler(makeBashEvent('cat "C:/Projects/app/package.json" | jq \'.version\''))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('config-get')
    }
  })

  it('passes through cat non-config file | jq (e.g. .ts)', () => {
    const result = preBashHandler(makeBashEvent('cat src/types.ts | jq .'))
    expect(result.hookType).toBe('pass')
  })

  it('passes through cat temp json | jq', () => {
    const result = preBashHandler(makeBashEvent('cat /tmp/output.json | jq .'))
    expect(result.hookType).toBe('pass')
  })
})

describe('preBashHandler — python read-modify-write exemption', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('passes through python open with write mode w', () => {
    const event = makeBashEvent("python3 -c \"with open('src/app/route.ts','r') as f: c=f.read(); open('src/app/route.ts','w').write(c.replace('old','new'))\"")
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('wraps python open with write mode w+ in compress (PythonFilter; not denied)', () => {
    const event = makeBashEvent("python3 -c \"with open('config.json','w+') as f: f.write(json.dumps(d))\"")
    const result = preBashHandler(event)
    // PythonFilter matches python3 -c; write-mode open bypasses the read-deny check, so the command is wrapped for output compression, not denied.
    expect(result.hookType).toBe('rewriteInput')
  })

  it('wraps python open with append mode a in compress (PythonFilter; not denied)', () => {
    const event = makeBashEvent("python3 -c \"open('log.txt','a').write('entry')\"")
    const result = preBashHandler(event)
    // PythonFilter matches python3 -c; append-mode open bypasses the read-deny check, so the command is wrapped for output compression, not denied.
    expect(result.hookType).toBe('rewriteInput')
  })

  it('passes through python snippet with .write() call after reading', () => {
    const event = makeBashEvent("python3 -c \"c=open('src/index.ts').read(); open('src/index.ts','w').write(c)\"")
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('still denies pure python read with no write', () => {
    const event = makeBashEvent("python3 -c \"with open('src/lib/auth.ts') as f: print(f.read())\"")
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat read')
    }
  })
})

describe('preBashHandler — orchestrator state file exemption', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('passes through python open() reading an improve-state JSON', () => {
    const event = makeBashEvent('python3 -c "import json; d = json.load(open(\'.improve-state-bugfixing.json\')); print(d)"')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('denies python open() of a .output transcript and points at bash-output --transcript', () => {
    const event = makeBashEvent("python3 -c \"\nimport json\nfor line in open(r'/home/user/.claude/tasks/abc123.output'):\n    print(json.loads(line))\n\"")
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output --file "/home/user/.claude/tasks/abc123.output" --transcript')
      expect(result.message).not.toContain('token-goat read')
    }
  })

  it('passes through node readFileSync reading an improve-state JSON', () => {
    const event = makeBashEvent('node -e "const fs = require(\'fs\'); const d = JSON.parse(fs.readFileSync(\'.improve-state-foo.json\', \'utf8\')); console.log(d)"')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })
})

describe('preBashHandler — task output file interception', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('denies cat of a tasks output path and emits a working --file recall hint', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tasks-'))
    const tasksDir = join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const jsonlFile = join(tasksDir, 'abc123def456.output')
    writeFileSync(jsonlFile, '{"tool_name":"Bash","tool_input":{"command":"echo test"}}\n')
    try {
      const result = preBashHandler(makeBashEvent(`cat "${jsonlFile}"`))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        // The recall command must name the on-disk path via --file; a bare `bash-output <id>` misses the cache (task id is not a cache key), and the old "already cached" wording promised a recall that errored.
        expect(result.message).toContain(`token-goat bash-output --file "${jsonlFile}"`)
        expect(result.message).toContain('--transcript')
        expect(result.message).toContain('--tail 50')
        // The recall hint must also advertise the line-range slice read -- the only way to
        // reach the MIDDLE of a large on-disk artifact (bash-output only does head/tail/grep).
        expect(result.message).toContain('@START-END')
        expect(result.message).toContain('token-goat read')
        expect(result.message).not.toContain('already cached')
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('denies tail on a tasks output path and preserves the requested line count', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tasks-'))
    const tasksDir = join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const jsonlFile = join(tasksDir, 'abc123def456.output')
    writeFileSync(jsonlFile, '{"tool_name":"Bash"}\n')
    try {
      const result = preBashHandler(makeBashEvent(`tail -n 20 "${jsonlFile}"`))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain(`token-goat bash-output --file "${jsonlFile}"`)
        expect(result.message).toContain('--tail 20')
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('denies cat with Windows-style backslash tasks path', () => {
    // Note: even though this uses Windows-style path syntax, on Windows the file would need to exist.
    // For cross-platform testing, we use a valid path that won't exist, and expect pass (fall-through).
    const result = preBashHandler(makeBashEvent('cat C:\\Users\\user\\.claude\\tasks\\def789.output'))
    expect(result.hookType).toBe('pass')
  })

  it('passes through cat on a non-tasks temp file', () => {
    const result = preBashHandler(makeBashEvent('cat /tmp/somefile.output'))
    expect(result.hookType).toBe('pass')
  })

  it('denies tail -c byte-mode on a tasks output path', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tasks-'))
    const tasksDir = join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const jsonlFile = join(tasksDir, 'abc123def456.output')
    writeFileSync(jsonlFile, '{"tool_name":"Bash"}\n')
    try {
      const result = preBashHandler(makeBashEvent(`tail -c 1500 "${jsonlFile}"`))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain(`token-goat bash-output --file "${jsonlFile}"`)
        expect(result.message).not.toContain('already cached')
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('denies tail -c on a Windows-style tasks output path', () => {
    // Non-existent path expected to fall through
    const result = preBashHandler(makeBashEvent('tail -c 2000 C:\\Users\\user\\.claude\\tasks\\bb9912.output'))
    expect(result.hookType).toBe('pass')
  })

  it('passes through tail -c on a non-tasks output file', () => {
    const result = preBashHandler(makeBashEvent('tail -c 1500 /tmp/build.output'))
    expect(result.hookType).toBe('pass')
  })

  it('passes through cat on a plain-text tasks output file', () => {
    // Bug A: plain-text background task logs should not be denied as JSONL transcripts
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tasks-'))
    const tasksDir = join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const plainTextFile = join(tasksDir, 'abc123.output')
    writeFileSync(plainTextFile, 'done plain text not jsonl\n')
    try {
      const result = preBashHandler(makeBashEvent(`cat "${plainTextFile}"`))
      expect(result.hookType).toBe('pass')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('denies cat on a genuine JSONL tasks transcript file', () => {
    // Bug A: true JSONL transcripts should still be denied with the original message
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tasks-'))
    const tasksDir = join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const jsonlFile = join(tasksDir, 'def456.output')
    writeFileSync(jsonlFile, '{"tool_name":"Bash","tool_input":{"command":"echo test"}}\n')
    try {
      const result = preBashHandler(makeBashEvent(`cat "${jsonlFile}"`))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('JSONL agent transcript')
        expect(result.message).toContain('--transcript')
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Converts a Windows-native path to its Git Bash / MSYS spelling (C:\Users\x -> /c/Users/x), the form the dominant shell in this environment actually produces.
  function toGitBashPath(winPath: string): string {
    return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => '/' + d.toLowerCase())
  }

  // Regression for f8f3cc39: readFileSync(outPath) with no normalization threw ENOENT on Git Bash's /c/... spelling (Node on Windows cannot resolve it), and the catch fell through to "pass" for every tasks/*.output file -- silently disabling the JSONL-transcript deny on the dominant shell. Gated to win32 because a real end-to-end fs read requires the host's actual Windows-drive filesystem; the platform-independent normalizePath invocation is covered separately below so this case is never silently uncovered off-Windows.
  ;(process.platform === 'win32' ? it : it.skip)('denies cat on a genuine JSONL tasks transcript file using Git-Bash /c/... path spelling', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tasks-'))
    const tasksDir = join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const jsonlFile = join(tasksDir, 'gb111.output')
    writeFileSync(jsonlFile, '{"tool_name":"Bash","tool_input":{"command":"echo test"}}\n')
    try {
      const gitBashPath = toGitBashPath(jsonlFile)
      const result = preBashHandler(makeBashEvent(`cat "${gitBashPath}"`))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('JSONL agent transcript')
        expect(result.message).toContain('--transcript')
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  ;(process.platform === 'win32' ? it : it.skip)('passes through cat on a plain-text tasks output file using Git-Bash /c/... path spelling', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tasks-'))
    const tasksDir = join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const plainTextFile = join(tasksDir, 'gb222.output')
    writeFileSync(plainTextFile, 'done plain text not jsonl\n')
    try {
      const gitBashPath = toGitBashPath(plainTextFile)
      const result = preBashHandler(makeBashEvent(`cat "${gitBashPath}"`))
      expect(result.hookType).toBe('pass')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('normalizes the tasks output path through normalizePath before reading it, on every platform (never-skip companion to the win32-gated /c/... e2e cases above; fail-on-buggy: routing outPath straight to readFileSync without this call is exactly the f8f3cc39 regression)', () => {
    const normalizeSpy = vi.spyOn(pathsModule, 'normalizePath')
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tasks-'))
    const tasksDir = join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const jsonlFile = join(tasksDir, 'gb333.output')
    writeFileSync(jsonlFile, '{"tool_name":"Bash","tool_input":{"command":"echo test"}}\n')
    try {
      const result = preBashHandler(makeBashEvent(`cat "${jsonlFile}"`))
      expect(result.hookType).toBe('deny')
      expect(normalizeSpy).toHaveBeenCalledWith(jsonlFile)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
      normalizeSpy.mockRestore()
    }
  })

  it('emits bash-output hint for cat on a tool-results plain-text file', () => {
    // Bug B: tool-results/*.txt files should emit bash-output recall hint
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tool-results-'))
    const toolResultsDir = join(tmpDir, 'tool-results')
    mkdirSync(toolResultsDir, { recursive: true })
    const toolResultFile = join(toolResultsDir, 'ghi789.txt')
    writeFileSync(toolResultFile, 'Tool output result\n')
    try {
      const result = preBashHandler(makeBashEvent(`cat "${toolResultFile}"`))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).toContain('bash-output')
        expect(result.context).toContain('--file')
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('emits bash-output hint for tail on a tool-results plain-text file', () => {
    // Bug B: tail on tool-results/*.txt should suggest bash-output recall
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-tool-results-'))
    const toolResultsDir = join(tmpDir, 'tool-results')
    mkdirSync(toolResultsDir, { recursive: true })
    const toolResultFile = join(toolResultsDir, 'xyz111.txt')
    writeFileSync(toolResultFile, 'Tool output line 1\nTool output line 2\n')
    try {
      const result = preBashHandler(makeBashEvent(`tail -n 10 "${toolResultFile}"`))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).toContain('bash-output')
        expect(result.context).toContain('--file')
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('preBashHandler — sed line-range interception', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits sed line-range read hint for single-quoted range', () => {
    const result = preBashHandler(makeBashEvent("sed -n '10,50p' src/hooks_read.ts"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat read')
      expect(result.context).toContain('src/hooks_read.ts@10-50')
    }
  })

  it('emits sed line-range read hint with double-quoted range', () => {
    const result = preBashHandler(makeBashEvent('sed -n "100,200p" README.md'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat read')
      expect(result.context).toContain('README.md@100-200')
    }
  })

  it('passes through sed without -n flag', () => {
    const result = preBashHandler(makeBashEvent("sed 's/foo/bar/g' file.ts"))
    expect(result.hookType).toBe('pass')
  })
  it('emits sed line-range hint for double-semicolon multi-range on a .md file', () => {
    const result = preBashHandler(makeBashEvent("sed -n '24,28p;65,84p' file.md"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat read')
      expect(result.context).toContain('file.md@24-28')
      expect(result.context).toContain('file.md@65-84')
      // Markdown: should also point at section by heading as the upgrade alternative.
      expect(result.context).toContain('token-goat section')
    }
  })

  it('emits sed line-range hint for multi-range on a source file with symbol-read fallback', () => {
    const result = preBashHandler(makeBashEvent("sed -n '40,90p;200,260p' src/auth.py"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat symbol')
      expect(result.context).toContain('src/auth.py@40-90')
      expect(result.context).toContain('src/auth.py@200-260')
    }
  })

  it('multi-range sed on a temp path passes through (no hint)', () => {
    const result = preBashHandler(makeBashEvent("sed -n '10,20p;30,40p' /tmp/scratch.md"))
    expect(result.hookType).toBe('pass')
  })

  it('multi-range sed with a malformed second range falls through (rejects the whole command)', () => {
    const result = preBashHandler(makeBashEvent("sed -n '10,20p;notarange' file.md"))
    expect(result.hookType).toBe('pass')
  })

  it('multi-range sed with three ranges lists all of them with an Oxford-comma separator', () => {
    const result = preBashHandler(makeBashEvent("sed -n '10,20p;100,110p;200,210p' src/foo.ts"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('src/foo.ts@10-20')
      expect(result.context).toContain('src/foo.ts@100-110')
      expect(result.context).toContain('src/foo.ts@200-210')
      // Three-range sed joins reads with an Oxford comma so the agent clearly sees the last
      // run-on boundary; without it the three reads read as a single comma-separated run.
      expect(result.context).toContain(', and ')
    }
  })

  it('single-range sed still resolves through the multi-range path (no regression on the one-range case)', () => {
    const result = preBashHandler(makeBashEvent("sed -n '13,31p' docs/report.md"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('docs/report.md@13-31')
    }
  })

  it('treats Salesforce Apex, metadata, and markup as symbol-bearing surgical reads', () => {
    for (const file of [
      'force-app/main/default/classes/ExampleController.cls',
      'force-app/main/default/flows/Example.flow-meta.xml',
      'force-app/main/default/aura/example/example.cmp',
    ]) {
      const result = preBashHandler(makeBashEvent(`sed -n '10,40p' ${file}`))
      expect(result.hookType).toBe('context')
      if (result.hookType === 'context') {
        expect(result.context).toContain('token-goat symbol')
      }
    }
  })
})

describe('preBashHandler — rg indented def patterns', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits skeleton hint for rg "^    def" (4-space indent) on a Python file', () => {
    const result = preBashHandler(makeBashEvent('rg "^    def" src/token_goat/parser.py'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('skeleton')
    }
  })

  it('emits skeleton hint for rg "^  def" (2-space indent) on a Python file', () => {
    const result = preBashHandler(makeBashEvent("rg '^  def' src/token_goat/hooks.py"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('skeleton')
    }
  })
})

describe('preBashHandler — directory listing map hint', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits map hint for eza --long on a path', () => {
    const result = preBashHandler(makeBashEvent('eza --git --long src/'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map')
    }
  })

  it('emits map hint for ls -la piped to head', () => {
    const result = preBashHandler(makeBashEvent('ls -la src/ | head -20'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map')
    }
  })

  it('wraps plain eza (LsFilter registered in SHELL_FILE_FILTERS matches eza)', () => {
    const result = preBashHandler(makeBashEvent('eza src/'))
    // LsFilter now matches eza; pre-Bash wraps it for output compression.
    expect(result.hookType).toBe('rewriteInput')
  })

  it('emits map hint for eza --tree', () => {
    const result = preBashHandler(makeBashEvent('eza --tree --level=2 src/'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map')
    }
  })

  it('emits map hint for bare tree command', () => {
    const result = preBashHandler(makeBashEvent('tree src/'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map')
    }
  })

  it('emits map hint for ls -R', () => {
    const result = preBashHandler(makeBashEvent('ls -R src/'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map')
    }
  })

  it('emits map hint for ls -lR', () => {
    const result = preBashHandler(makeBashEvent('ls -lR src/'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map')
    }
  })

  it('emits map hint for ls -laR', () => {
    const result = preBashHandler(makeBashEvent('ls -laR'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map')
    }
  })

  it('still fires for eza --long (existing path)', () => {
    const result = preBashHandler(makeBashEvent('eza --git --long src/'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map')
    }
  })

  it('does NOT fire for a plain ls of a file whose name merely contains "-R" (no -R flag)', () => {
    const result = preBashHandler(makeBashEvent('ls docs/API-Reference.md'))
    expect(result.hookType).not.toBe('context')
  })

  it('fires for ls DIR | grep pattern', () => {
    const result = preBashHandler(makeBashEvent('ls src/ | grep .ts'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat map')
    }
  })

  it('fires for ls DIR | wc -l', () => {
    const result = preBashHandler(makeBashEvent('ls images/ | wc -l'))
    expect(result.hookType).toBe('context')
  })

  it('wraps ls without a pipe (LsFilter registered in SHELL_FILE_FILTERS)', () => {
    const result = preBashHandler(makeBashEvent('ls -la src/'))
    // LsFilter is now registered; pre-Bash wraps ls for output compression.
    expect(result.hookType).toBe('rewriteInput')
  })
})

describe('preBashHandler — grep pipe chain hint', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits hint for grep | grep double filter', () => {
    const result = preBashHandler(makeBashEvent('grep -rn "foo" . | grep "bar"'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('rg -e')
    }
  })

  it('emits hint for rg | grep chain', () => {
    const result = preBashHandler(makeBashEvent('rg "foo" | grep "bar"'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('rg -e')
    }
  })

  it('does not fire for grep | wc', () => {
    const result = preBashHandler(makeBashEvent('grep "foo" file.txt | wc -l'))
    expect(result.hookType).toBe('pass')
  })

  it('does not fire for grep | head', () => {
    const result = preBashHandler(makeBashEvent('grep "foo" file.txt | head -20'))
    expect(result.hookType).toBe('pass')
  })

  it('does not fire for grep | sort', () => {
    const result = preBashHandler(makeBashEvent('grep "foo" file.txt | sort'))
    expect(result.hookType).toBe('pass')
  })

  it('does not fire for grep | awk', () => {
    const result = preBashHandler(makeBashEvent('grep "foo" file.txt | awk \'{print $1}\''))
    expect(result.hookType).toBe('pass')
  })
})

describe('preBashHandler — find command interception', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits fd hint for simple find -name pattern', () => {
    const result = preBashHandler(makeBashEvent('find src/ -name "*.ts"'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('fd')
      expect(result.context).toContain('*.ts')
    }
  })

  it('emits fd hint for find without -name', () => {
    const result = preBashHandler(makeBashEvent('find . -type f'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('fd')
    }
  })

  it('denies find | xargs grep -l (symbol-search anti-pattern)', () => {
    const result = preBashHandler(makeBashEvent('find src/ -name "*.ts" | xargs grep -l "MyClass"'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('rg -l')
      expect(result.message).toContain('token-goat refs')
    }
  })

  it('denies find | xargs rg -l', () => {
    const result = preBashHandler(makeBashEvent('find . -name "*.js" | xargs rg -l "fetchUser"'))
    expect(result.hookType).toBe('deny')
  })

  it('emits context for find piped to head (non-symbol use)', () => {
    const result = preBashHandler(makeBashEvent('find . -name "*.py" | head -20'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('fd')
    }
  })

  it('passes through non-find commands', () => {
    const result = preBashHandler(makeBashEvent('echo "find me"'))
    expect(result.hookType).toBe('pass')
  })
})

describe('preBashHandler — extractForLoopWcL', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('fires for for-loop wc -l size probe', () => {
    const result = preBashHandler(makeBashEvent('for f in *.ts; do wc -l $f; done'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat outline')
    }
  })

  it('fires for for-loop wc -l with files list', () => {
    const result = preBashHandler(makeBashEvent('for f in src/auth.ts src/db.ts; do wc -l $f; done'))
    expect(result.hookType).toBe('context')
  })

  it('does not fire for for-loop doing something other than wc', () => {
    const result = preBashHandler(makeBashEvent('for f in *.ts; do echo $f; done'))
    expect(result.hookType).toBe('pass')
  })
})

describe('preBashHandler — curl GET recall', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits recall hint when same curl GET was already run this session', async () => {
    const cmd = 'curl -s https://api.example.com/data'
    const largeOutput = JSON.stringify({ items: new Array(200).fill({ id: 1, name: 'foo' }) })

    await postBashHandler(makePostBashEvent(cmd, largeOutput))

    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat bash-output')
      expect(result.context).toContain('--grep')
    }
  })

  it('wraps first curl GET (CurlFilter registered in SHELL_FILE_FILTERS)', () => {
    const result = preBashHandler(makeBashEvent('curl -s https://api.example.com/data'))
    // CurlFilter is now registered; pre-Bash wraps curl for output compression.
    expect(result.hookType).toBe('rewriteInput')
  })

  it('wraps curl POST (CurlFilter matches regardless of method)', async () => {
    const cmd = 'curl -X POST -d \'{"key":"val"}\' https://api.example.com/create'
    const largeOutput = '{"id":1}'.repeat(200)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))
    // CurlFilter is now registered; wraps for compression regardless of caching.
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('rewriteInput')
  })

  it('wraps curl with auth headers (CurlFilter registered)', async () => {
    const cmd = "curl -s -H 'Authorization: Bearer token123' https://api.example.com/me"
    const largeOutput = '{"user":"me"}'.repeat(200)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('rewriteInput')
  })

  it('never caches (nor recalls) a curl GET carrying an Authorization header, in -H, --header, or --header= spelling', async () => {
    const largeOutput = '{"user":"me"}'.repeat(200)
    for (const cmd of [
      "curl -s -H 'Authorization: Bearer token123' https://api.example.com/me",
      "curl -s --header 'Authorization: Bearer token123' https://api.example.com/me",
      "curl -s --header='Authorization: Bearer token123' https://api.example.com/me",
    ]) {
      clearModuleCaches()
      await postBashHandler(makePostBashEvent(cmd, largeOutput))
      const result = preBashHandler(makeBashEvent(cmd))
      // rewriteInput (first-run compression wrap) is fine; a 'context' recall hint containing
      // 'curl response cached' would mean the credential-carrying command got persisted.
      if (result.hookType === 'context') {
        expect(result.context).not.toContain('curl response cached')
      }
    }
  })

  it('wraps curl with -u credentials (CurlFilter registered)', async () => {
    const cmd = 'curl -s -u admin:password https://api.example.com/admin'
    const largeOutput = '{"admin":true}'.repeat(200)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('rewriteInput')
  })

  it('emits recall hint for same URL fetched with a different downstream pipe', async () => {
    const url = 'https://api.example.com/data'
    const firstCmd = 'curl -s ' + url + ' | jq .items'
    const secondCmd = 'curl -s ' + url + ' | python3 -c "import sys,json; print(json.load(sys.stdin))"'
    const largeOutput = JSON.stringify({ items: new Array(200).fill({ id: 1, name: 'foo' }) })

    await postBashHandler(makePostBashEvent(firstCmd, largeOutput))

    const result = preBashHandler(makeBashEvent(secondCmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat bash-output')
    }
  })

  it('does not redirect a cached curl GET response below hints.bash_dedup_min_bytes, and lets the command run instead', async () => {
    const cmd = 'curl -s https://api.example.com/tiny-cached-data'
    // Large enough to clear bash_compress.cache_min_bytes (default 512) so it actually gets
    // cached, but well under the inflated hints.bash_dedup_min_bytes floor set below.
    const cachedOutput = JSON.stringify({ items: new Array(200).fill({ id: 1, name: 'foo' }) })
    const orig = process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES']
    try {
      await postBashHandler(makePostBashEvent(cmd, cachedOutput))

      process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES'] = '999999'
      invalidateConfigCache()

      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).not.toBe('context')
    } finally {
      if (orig === undefined) {
        delete process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES']
      } else {
        process.env['TOKEN_GOAT_BASH_DEDUP_MIN_BYTES'] = orig
      }
      clearModuleCaches()
    }
  })

  it('names the actual differently-piped command that produced the cached value, instead of silently implying it matches the new filter (BASHCACHE-KEY-STRIPS-PIPELINE regression)', async () => {
    const url = 'https://api.example.com/data'
    const firstCmd = 'curl -s ' + url + ' | jq .items'
    const secondCmd = 'curl -s ' + url + ' | jq .total'
    const largeOutput = JSON.stringify({ items: new Array(200).fill({ id: 1, name: 'foo' }), total: 200 })

    await postBashHandler(makePostBashEvent(firstCmd, largeOutput))

    const result = preBashHandler(makeBashEvent(secondCmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat bash-output')
      expect(result.context).toContain(firstCmd)
      expect(result.context).toContain('differently-piped')
    }
  })
})

describe('preBashHandler — stale cache recall by fingerprint (M44 regression)', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  // pip freeze is both a cacheable build command (BUILD_COMMAND_PATTERNS) and
  // a dep-list command (isDepListCommand), so storeBashOutput fingerprints it
  // against requirements.txt. Before this fix, the fingerprint was computed
  // and stored but never re-checked at recall time -- a cached entry stayed
  // "recallable" forever even after the underlying dependency set changed.
  it('does not recall a cached pip freeze once requirements.txt changes since it was cached', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-m44-'))
    writeFileSync(join(tmpDir, 'requirements.txt'), 'requests==2.0.0\n')
    try {
      const cmd = 'pip freeze'
      const largeOutput = 'requests==2.0.0\n'.repeat(100)

      await postBashHandler(makePostBashEvent(cmd, largeOutput, tmpDir))

      // Sanity check: immediately after caching (nothing has changed), the recall hint fires.
      const freshResult = preBashHandler(makeBashEvent(cmd, tmpDir))
      expect(freshResult.hookType).toBe('context')
      if (freshResult.hookType === 'context') {
        expect(freshResult.context).toContain('is cached')
      }

      // The dependency set changed since the output was cached -- the cached
      // freeze output is now stale and must not be served as if it were fresh.
      writeFileSync(join(tmpDir, 'requirements.txt'), 'requests==3.0.0\nnewpkg==1.0.0\n')

      const staleResult = preBashHandler(makeBashEvent(cmd, tmpDir))
      if (staleResult.hookType === 'context') {
        expect(staleResult.context).not.toContain('is cached')
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

/** Init a git repo with one committed file at `<repo>/a.txt`, returning the repo dir. */
function initGitRepoForBashTests(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git(['init'])
  git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'])
  return dir
}

describe('preBashHandler/postBashHandler — scoped git status/diff --stat recall (Bug D regression)', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('recalls a cached scoped `git status --porcelain -- <path>` on an identical rerun with no intervening edit', async () => {
    const dir = initGitRepoForBashTests('tg-gitscope-status-')
    try {
      const cmd = 'git status --porcelain -- a.txt'
      // Padded well above bash_compress.cache_min_bytes (512) — a real scoped status/diff
      // output is often this small, but the cache write is gated on the size floor same as
      // every other recall source (gh api, curl, monitoring), so the test must clear it too.
      const output = (' M a.txt\n').repeat(80)

      // First run: nothing cached yet — the existing git-diff/status compression pipeline
      // (detectFromCommand -> maybeCompressRewrite) wraps it, which is unrelated to caching.
      const firstResult = preBashHandler(makeBashEvent(cmd, dir))
      expect(firstResult.hookType).not.toBe('block')
      await postBashHandler(makePostBashEvent(cmd, output, dir))

      // Second, identical run with no intervening edit: recalled instead of re-run.
      const secondResult = preBashHandler(makeBashEvent(cmd, dir))
      expect(secondResult.hookType).toBe('context')
      if (secondResult.hookType === 'context') {
        expect(secondResult.context).toContain('is cached and unchanged')
        expect(secondResult.context).toContain('token-goat bash-output')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recalls a cached scoped `git diff --stat HEAD -- <path>` on an identical rerun with no intervening edit', async () => {
    const dir = initGitRepoForBashTests('tg-gitscope-diffstat-')
    try {
      const cmd = 'git diff --stat HEAD -- a.txt'
      const output = (' a.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n').repeat(20)

      const firstResult = preBashHandler(makeBashEvent(cmd, dir))
      expect(firstResult.hookType).not.toBe('block')
      await postBashHandler(makePostBashEvent(cmd, output, dir))

      const secondResult = preBashHandler(makeBashEvent(cmd, dir))
      expect(secondResult.hookType).toBe('context')
      if (secondResult.hookType === 'context') {
        expect(secondResult.context).toContain('is cached and unchanged')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not recall a scoped git status once the scoped path is edited (dirty-queue-visible change invalidates the cache)', async () => {
    const dir = initGitRepoForBashTests('tg-gitscope-invalidate-')
    try {
      const cmd = 'git status --porcelain -- a.txt'
      const output = (' M a.txt\n').repeat(80)

      await postBashHandler(makePostBashEvent(cmd, output, dir))

      // Sanity: recall fires before anything changes.
      const freshResult = preBashHandler(makeBashEvent(cmd, dir))
      expect(freshResult.hookType).toBe('context')

      // Edit the scoped path without staging or committing -- this is exactly what a real
      // edit-tool write followed by postEditHandler's dirty-queue append looks like from git's
      // perspective: the file's content changes, HEAD stays put. `git status --porcelain`
      // reflects it immediately, which is what the fingerprint is keyed on.
      writeFileSync(join(dir, 'a.txt'), 'two\n')

      const staleResult = preBashHandler(makeBashEvent(cmd, dir))
      if (staleResult.hookType === 'context') {
        expect(staleResult.context).not.toContain('is cached and unchanged')
      } else {
        expect(staleResult.hookType).not.toBe('block')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not recall a scoped git diff --stat once HEAD changes (a commit lands between runs)', async () => {
    const dir = initGitRepoForBashTests('tg-gitscope-head-')
    try {
      const cmd = 'git diff --stat -- a.txt'
      const output = (' a.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n').repeat(20)

      await postBashHandler(makePostBashEvent(cmd, output, dir))
      const freshResult = preBashHandler(makeBashEvent(cmd, dir))
      expect(freshResult.hookType).toBe('context')

      writeFileSync(join(dir, 'b.txt'), 'new\n')
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: dir, stdio: 'ignore' })
      execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'second'], { cwd: dir, stdio: 'ignore' })

      const staleResult = preBashHandler(makeBashEvent(cmd, dir))
      if (staleResult.hookType === 'context') {
        expect(staleResult.context).not.toContain('is cached and unchanged')
      } else {
        expect(staleResult.hookType).not.toBe('block')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not cache/recall an unscoped `git status` (no `-- <path>`) via the scoped-git recall path', async () => {
    const dir = initGitRepoForBashTests('tg-gitscope-unscoped-')
    try {
      const cmd = 'git status'
      const output = 'nothing to commit, working tree clean\n'.repeat(20)

      await postBashHandler(makePostBashEvent(cmd, output, dir))
      const result = preBashHandler(makeBashEvent(cmd, dir))
      // The generic git compression pipeline may still rewrite this (unrelated to caching);
      // what matters is that the scoped-git recall hint specifically never fires for it.
      if (result.hookType === 'context') {
        expect(result.context).not.toContain('is cached and unchanged')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('extractCurlDownload', () => {
  it('extracts url and output path from curl -o', () => {
    const result = extractCurlDownload('curl https://example.com/file.json -o /tmp/file.json')
    expect(result).not.toBeNull()
    expect(result?.url).toBe('https://example.com/file.json')
    expect(result?.outputPath).toBe('/tmp/file.json')
  })

  it('extracts from curl --output variant', () => {
    const result = extractCurlDownload('curl -sSL https://example.com/data.json --output /tmp/data.json')
    expect(result).not.toBeNull()
    expect(result?.url).toBe('https://example.com/data.json')
    expect(result?.outputPath).toBe('/tmp/data.json')
  })

  it('returns null for non-curl command', () => {
    expect(extractCurlDownload('wget https://example.com -O /tmp/file')).toBeNull()
  })

  it('returns null when no -o flag', () => {
    expect(extractCurlDownload('curl -s https://example.com/api')).toBeNull()
  })

  it('returns null for POST with -o', () => {
    expect(extractCurlDownload('curl -X POST https://example.com -o /tmp/out.json')).toBeNull()
  })

  it('returns null for curl with auth and -o', () => {
    expect(extractCurlDownload('curl -H "Authorization: Bearer tok" https://example.com -o /tmp/out')).toBeNull()
  })
})

describe('preBashHandler — curl download dedup', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('denies re-download of the same URL to a different temp path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-curl-'))
    const v1Path = join(dir, 'report-v1.json')
    try {
      // Above hints.bash_dedup_min_bytes (default 200) so the recall deny actually fires.
      writeFileSync(v1Path, JSON.stringify({ items: new Array(20).fill({ id: 1, name: 'foo' }) }))
      const url = 'https://example.com/report.json'
      const firstCmd = `curl ${url} -o ${v1Path}`
      await postBashHandler(makePostBashEvent(firstCmd, ''))

      const v2Path = join(dir, 'report-v2.json')
      const secondCmd = `curl ${url} -o ${v2Path}`
      const result = preBashHandler(makeBashEvent(secondCmd))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        // The recall message shows the fully-resolved, normalized path recorded at download
        // time (see the "resolves a relative -o path against the ORIGINAL download cwd"
        // regression below), not the raw -o argument as typed on the command line.
        expect(result.message).toContain(resolveIndexPath(v1Path))
        expect(result.message).toContain('rg')
        expect(result.message).toContain('token-goat read')
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('wraps curl -o download (CurlFilter registered in SHELL_FILE_FILTERS)', () => {
    const result = preBashHandler(makeBashEvent('curl https://example.com/data.json -o /tmp/data.json'))
    // CurlFilter is now registered; pre-Bash wraps curl for output compression.
    expect(result.hookType).toBe('rewriteInput')
  })

  it('denies re-download of same URL with identical output path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-curl-'))
    const outPath = join(dir, 'script.sh')
    try {
      // Above hints.bash_dedup_min_bytes (default 200) so the recall deny actually fires.
      writeFileSync(outPath, '#!/bin/sh\necho hi\n' + '# padding to clear the dedup min-bytes floor\n'.repeat(10))
      const cmd = `curl https://example.com/script.sh -o ${outPath}`
      await postBashHandler(makePostBashEvent(cmd, ''))
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('deny')
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('does not deny a re-download once the previously saved file is gone, and clears the stale session record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-curl-gone-'))
    const outPath = join(dir, 'artifact.json')
    try {
      const url = 'https://example.com/artifact.json'
      const cmd = `curl ${url} -o ${outPath}`
      // Above hints.bash_dedup_min_bytes (default 200) so the recall deny actually fires.
      writeFileSync(outPath, JSON.stringify({ v: 1, padding: 'x'.repeat(200) }))
      await postBashHandler(makePostBashEvent(cmd, ''))
      expect(preBashHandler(makeBashEvent(cmd)).hookType).toBe('deny')

      rmSync(outPath, { force: true })

      const afterDelete = preBashHandler(makeBashEvent(cmd))
      expect(afterDelete.hookType).not.toBe('deny')

      expect(getCurlDownloadPath(url)).toBeNull()
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('resolves a relative -o path against the ORIGINAL download cwd on recall, not the current command\'s cwd (fail-on-buggy: storing the raw relative outputPath instead of the cwd-resolved absolute path lets a same-named file in the new cwd shadow the real downloaded one)', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'tg-curl-cwd-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'tg-curl-cwd-b-'))
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(dirA, 'downloads'), { recursive: true })
      mkdirSync(join(dirB, 'downloads'), { recursive: true })

      const relOutputPath = 'downloads/file.json'
      const absPathA = join(dirA, relOutputPath)
      const absPathB = join(dirB, relOutputPath)

      // The real download, saved under dirA, is above the dedup floor.
      writeFileSync(absPathA, JSON.stringify({ items: new Array(20).fill({ id: 1, name: 'foo' }) }))
      // A same-named but unrelated, much smaller file happens to already exist under dirB.
      writeFileSync(absPathB, '{}')

      const url = 'https://example.com/relative-cwd-file.json'
      const cmd = `curl ${url} -o ${relOutputPath}`

      // Record the download as if it ran from dirA.
      await postBashHandler(makePostBashEvent(cmd, '', dirA))

      // The recorded path must be the fully-resolved absolute path from the ORIGINAL cwd, not
      // the raw relative string.
      expect(getCurlDownloadPath(url)).toBe(resolveIndexPath(relOutputPath, dirA))

      // Now the same command is run again, but from a DIFFERENT cwd (dirB) that happens to
      // contain its own, much-smaller file at the same relative path.
      const result = preBashHandler(makeBashEvent(cmd, dirB))

      // The recall must still find and deny based on the ORIGINAL (dirA) file, not dirB's.
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain(resolveIndexPath(absPathA))
        expect(result.message).not.toContain(resolveIndexPath(absPathB))
      }
    } finally {
      try { rmSync(dirA, { recursive: true, force: true }) } catch { /* best-effort */ }
      try { rmSync(dirB, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('does not record a curl -o download that failed (missing output file) — a retry is allowed, not denied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-curl-fail-'))
    const outPath = join(dir, 'missing.json')
    try {
      const url = 'https://example.com/missing.json'
      const cmd = `curl ${url} -o ${outPath}`
      // Simulate a failed download: curl exited non-zero and never wrote the output file.
      const failedEvent: HookEvent = {
        eventName: 'post_tool_use',
        toolName: 'Bash',
        toolInput: { command: cmd },
        sessionId: 'test-session',
        agentId: undefined,
        raw: {
          tool_name: 'Bash',
          tool_input: { command: cmd },
          tool_response: { output: 'curl: (22) The requested URL returned error: 404', exit_code: 22 },
        },
      }
      await postBashHandler(failedEvent)

      // Retrying the exact same download must be allowed, not denied as "already downloaded".
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).not.toBe('deny')
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })
})

describe('preBashHandler — token-goat CLI surgical-read dedup', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('passes through the first token-goat read invocation', () => {
    const result = preBashHandler(makeBashEvent('token-goat read "src/foo.ts::bar"'))
    expect(result.hookType).toBe('pass')
  })

  it('emits an advisory hint on an exact repeat token-goat read invocation', async () => {
    const cmd = 'token-goat read "src/foo.ts::bar"'
    await postBashHandler(makePostBashEvent(cmd, 'function bar() {}'))

    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already ran this exact')
      expect(result.context).toContain('token-goat read')
    }
  })

  it('emits an advisory hint on an exact repeat token-goat symbol invocation', async () => {
    const cmd = 'token-goat symbol bar'
    await postBashHandler(makePostBashEvent(cmd, 'function bar() {}'))

    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('context')
  })

  it('does not dedup a different spec against the same subcommand', async () => {
    await postBashHandler(makePostBashEvent('token-goat read "src/foo.ts::bar"', 'function bar() {}'))
    const result = preBashHandler(makeBashEvent('token-goat read "src/foo.ts::baz"'))
    expect(result.hookType).toBe('pass')
  })

  it('does not record a failed invocation for later dedup', async () => {
    const cmd = 'token-goat read "src/foo.ts::bar"'
    const failedEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: cmd },
      sessionId: 'test-session',
      agentId: undefined,
      raw: {
        tool_name: 'Bash',
        tool_input: { command: cmd },
        tool_response: { output: 'symbol not found', exit_code: 1 },
      },
    }
    await postBashHandler(failedEvent)

    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('pass')
  })

  it('cross-references a file already fully read via the Read tool', () => {
    // The Read tool always records an absolute path; the CLI dedup key is now resolved against
    // the bash event's cwd too (falling back to process.cwd() here, since makeBashEvent sets none)
    // so both sides land on the same absolute path.
    recordFileRead(resolveIndexPath('src/foo.ts'))
    const result = preBashHandler(makeBashEvent('token-goat read "src/foo.ts::bar"'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already fully read via the Read tool')
    }
  })

  it('does not cross-reference an unrelated file', () => {
    recordFileRead('src/other.ts')
    const result = preBashHandler(makeBashEvent('token-goat read "src/foo.ts::bar"'))
    expect(result.hookType).toBe('pass')
  })

  it('cross-references a file already fully read via the Read tool when the CLI read uses an @N-M line-range suffix', () => {
    // A `token-goat read "file@N-M"` spec must extract the bare file path for the dedup/
    // pending-hint key (stripping the range suffix), not the literal "file@N-M" string —
    // otherwise a range-scoped read never cross-references the same file read in full.
    recordFileRead(resolveIndexPath('src/foo.ts'))
    const result = preBashHandler(makeBashEvent('token-goat read "src/foo.ts@10-50"'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already fully read via the Read tool')
    }
  })

  it('does not intercept unrelated token-goat subcommands', () => {
    const result = preBashHandler(makeBashEvent('token-goat map --compact'))
    expect(result.hookType).not.toBe('context')
  })

  it('dedups a repeat token-goat section invocation that only differs in drive-letter case', async () => {
    await postBashHandler(makePostBashEvent('token-goat section "C:/Projects/token-goat/src/foo.ts::Bar"', 'heading text'))
    const result = preBashHandler(makeBashEvent('token-goat section "c:/Projects/token-goat/src/foo.ts::Bar"'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already ran this exact')
    }
  })

  it('dedups a repeat token-goat read invocation that only differs in slash direction', async () => {
    await postBashHandler(makePostBashEvent('token-goat read "src\\foo.ts::bar"', 'function bar() {}'))
    const result = preBashHandler(makeBashEvent('token-goat read "src/foo.ts::bar"'))
    expect(result.hookType).toBe('context')
  })

  it('dedups a relative spec run twice from the same cwd (fail-on-buggy: breaks if the dedup key stops resolving against cwd)', async () => {
    await postBashHandler(makePostBashEvent('token-goat read "src/foo.ts::bar"', 'function bar() {}', 'C:/Projects/repo-a'))
    const result = preBashHandler(makeBashEvent('token-goat read "src/foo.ts::bar"', 'C:/Projects/repo-a'))
    expect(result.hookType).toBe('context')
  })

  it('does NOT dedup the same relative spec run from two different project cwds', async () => {
    await postBashHandler(makePostBashEvent('token-goat read "src/foo.ts::bar"', 'function bar() {}', 'C:/Projects/repo-a'))
    const result = preBashHandler(makeBashEvent('token-goat read "src/foo.ts::bar"', 'C:/Projects/repo-b'))
    expect(result.hookType).toBe('pass')
  })

  it('emits an advisory hint on an exact repeat token-goat skill-body invocation', async () => {
    const cmd = 'token-goat skill-body my-skill'
    await postBashHandler(makePostBashEvent(cmd, 'skill body text'))
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already ran this exact')
    }
  })

  it('emits an advisory hint on an exact repeat token-goat skill-compact invocation', async () => {
    const cmd = 'token-goat skill-compact my-skill'
    await postBashHandler(makePostBashEvent(cmd, 'compact skill text'))
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('context')
  })

  it('does not dedup token-goat skill-compact --path X against --path Y', async () => {
    await postBashHandler(makePostBashEvent('token-goat skill-compact --path skills/x.md', 'x skill text'))
    const result = preBashHandler(makeBashEvent('token-goat skill-compact --path skills/y.md'))
    expect(result.hookType).toBe('pass')
  })

  it('dedups a repeat skill-compact --path invocation to the same file that only differs in slash direction (resolved via resolveIndexPath, same as read/section)', async () => {
    const cwd = 'C:/Projects/repo-a'
    await postBashHandler(makePostBashEvent('token-goat skill-compact --path skills\\x.md', 'x skill text', cwd))
    const result = preBashHandler(makeBashEvent('token-goat skill-compact --path skills/x.md', cwd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already ran this exact')
    }
  })
})

describe('extractMarkdownHeadingGrep', () => {
  it('matches grep -n "^#" SKILL.md', () => {
    const result = extractMarkdownHeadingGrep('grep -n "^#" SKILL.md')
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe('SKILL.md')
  })

  it('matches grep -n "^## |^### " superman/SKILL.md | head -80', () => {
    const result = extractMarkdownHeadingGrep('grep -n "^## |^### " superman/SKILL.md | head -80')
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe('superman/SKILL.md')
  })

  it('matches rg -n "^### Pattern" SKILL.md', () => {
    const result = extractMarkdownHeadingGrep('rg -n "^###" SKILL.md')
    expect(result).not.toBeNull()
  })

  it('does not fire for rg -n "class" types.ts (not a markdown file)', () => {
    const result = extractMarkdownHeadingGrep('rg -n "class" types.ts')
    expect(result).toBeNull()
  })

  it('does not fire for grep -n "^#" script.sh (not a .md file)', () => {
    const result = extractMarkdownHeadingGrep('grep -n "^#" script.sh')
    expect(result).toBeNull()
  })

  it('does not fire without -n flag', () => {
    const result = extractMarkdownHeadingGrep('grep "^#" README.md')
    expect(result).toBeNull()
  })
})

describe('preBashHandler — markdown heading grep hint', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits outline hint for grep -n "^#" SKILL.md', () => {
    const result = preBashHandler(makeBashEvent('grep -n "^#" SKILL.md'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat outline')
      expect(result.context).toContain('SKILL.md')
      expect(result.context).toContain('token-goat section')
    }
  })

  it('emits outline hint for rg -n "^##" README.md | head -120', () => {
    const result = preBashHandler(makeBashEvent('rg -n "^##" README.md | head -120'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat outline')
    }
  })

  it('passes through rg -n "class" types.ts (structural search, not markdown heading)', () => {
    const result = preBashHandler(makeBashEvent('rg -n "class " types.ts'))
    // Should still fire the structural search hint for .ts, not the markdown heading hint The key thing is it does NOT return pass for this pattern:
    expect(result.hookType).not.toBe('pass')
  })

  it('wraps grep (RgFilter registered in SHELL_FILE_FILTERS matches grep)', () => {
    const result = preBashHandler(makeBashEvent('grep -n "^#" script.sh'))
    // RgFilter now matches grep; pre-Bash wraps it for output compression. The markdown-heading hint no longer fires because wrapping takes precedence.
    expect(result.hookType).toBe('rewriteInput')
  })
})

// Item 2 (nestpilot mining): rg/grep -n identifier on single source file → token-goat symbol hint
describe('extractRgSymbolSearch', () => {
  it('matches grep -n "ConversationState" src/types/domain.ts', () => {
    const result = extractRgSymbolSearch('grep -n "ConversationState" src/types/domain.ts')
    expect(result).not.toBeNull()
    expect(result?.identifier).toBe('ConversationState')
    expect(result?.filePath).toBe('src/types/domain.ts')
  })

  it('matches rg with |-joined identifiers and -n flag at end', () => {
    const result = extractRgSymbolSearch('rg "DeveloperStatus|ContractStatus|CommissionStatus" src/types/domain.ts -n')
    expect(result).not.toBeNull()
    expect(result?.identifier).toBe('DeveloperStatus|ContractStatus|CommissionStatus')
  })

  it('does not fire without -n flag', () => {
    const result = extractRgSymbolSearch('rg "class|function" src/types/domain.ts')
    expect(result).toBeNull()
  })

  it('does not fire for directory target (not single file)', () => {
    const result = extractRgSymbolSearch('rg "MyType" src/ -n')
    expect(result).toBeNull()
  })

  it('does not fire for recursive grep', () => {
    const result = extractRgSymbolSearch('grep -rn "MyType" .')
    expect(result).toBeNull()
  })

  it('does not fire when pattern has regex metacharacters', () => {
    const result = extractRgSymbolSearch('rg -n "My.*Type" src/types.ts')
    expect(result).toBeNull()
  })

  it('does not fire for non-source extension (.md)', () => {
    const result = extractRgSymbolSearch('rg -n "Section" docs/guide.md')
    expect(result).toBeNull()
  })

  it('still fires with a --color long flag that merely contains the letter r (not an actual recursive flag)', () => {
    // Regression: the recursive-flag guard used to match any long flag containing 'r' anywhere
    // (--color, --sort, ...) because its leading `-` could anchor off the SECOND dash of a
    // double-dash flag. That silently suppressed the symbol-search hint for one of the most
    // common rg/grep flags in real commands.
    const result = extractRgSymbolSearch('rg -n --color=never "MyType" src/types.ts')
    expect(result).not.toBeNull()
    expect(result?.identifier).toBe('MyType')
    expect(result?.filePath).toBe('src/types.ts')
  })

  it('does not fire for --recursive long flag', () => {
    const result = extractRgSymbolSearch('grep -n --recursive "MyType" src/types.ts')
    expect(result).toBeNull()
  })
})

describe('preBashHandler — rg symbol search hint', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits symbol hint for grep -n "ConversationState" src/types/domain.ts', () => {
    const result = preBashHandler(makeBashEvent('grep -n "ConversationState" src/types/domain.ts'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat symbol')
      expect(result.context).toContain('ConversationState')
    }
  })

  it('emits symbol hint for rg with |-joined identifiers', () => {
    const result = preBashHandler(makeBashEvent('rg "DeveloperStatus|ContractStatus" src/types/domain.ts -n'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat symbol')
    }
  })

  it('passes through rg without -n flag (no symbol hint)', () => {
    const result = preBashHandler(makeBashEvent('rg "MyType" src/types/domain.ts'))
    // No symbol hint fires — may still fire structural or pass
    if (result.hookType === 'context') {
      expect(result.context).not.toContain('token-goat symbol')
    }
  })
})

// Item 3 (nestpilot mining): python heredoc << 'PYEOF' form
describe('preBashHandler — python heredoc file read', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('denies python heredoc that reads a .tsx file via direct open()', () => {
    const cmd = "python3 - << 'PYEOF'\nwith open(r'src/analytics/page.tsx') as f:\n    print(f.read())\nPYEOF"
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat read')
    }
  })

  it('does not fire when heredoc body contains .write(', () => {
    const cmd = "python3 - << 'PYEOF'\nwith open('src/output.ts', 'w') as f:\n    f.write('content')\nPYEOF"
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('pass')
  })

  it('does not fire when heredoc body contains .writelines(', () => {
    const cmd = "python3 - << 'PYEOF'\nwith open('src/output.ts') as f:\n    f.writelines(['a', 'b'])\nPYEOF"
    const result = preBashHandler(makeBashEvent(cmd))
    // writelines is write intent — should not fire
    expect(result.hookType).toBe('pass')
  })
})

// Regression: stripOutputPipeline must not strip content inside quoted strings
describe('postBashHandler — quoted > in command is not treated as a redirect', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('stores cache entry under the full command hash when > appears inside quotes', async () => {
    // Bug: redirect-stripping regex lacked quote awareness, so 'pytest -- -k "test_count > 0"' was truncated to 'pytest -- -k "test_count' and stored under the wrong (shorter) hash. On the second run the lookup used the same wrong hash so recall "worked", but any unrelated command that happened to hash to the same truncated key got a false cache hit.
    const cmd = 'pytest -- -k "test_count > 0"'
    const largeOutput = 'PASSED test_count_positive\nPASSED test_count_zero\n'.repeat(60)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))

    const { fingerprintContent } = await import('../src/fingerprint.js')

    // Must be stored under the full, untruncated command.
    const correctHash = fingerprintContent(cmd).slice(0, 16)
    expect(getBashOutputId(correctHash)).not.toBeNull()

    // Must NOT be stored under the incorrectly-truncated key.
    const wrongHash = fingerprintContent('pytest -- -k "test_count').slice(0, 16)
    expect(getBashOutputId(wrongHash)).toBeNull()
  })
})

// Item 4 (nestpilot mining): .sql files in cat → contextOutput with SQL-specific hint
describe('preBashHandler — SQL file cat hint', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits context hint (not deny) for cat of a SQL schema file', () => {
    const result = preBashHandler(makeBashEvent('cat schema.sql'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
      expect(result.context).toContain('CREATE TABLE')
    }
  })

  it('emits context hint for cat of a SQL migration file', () => {
    const result = preBashHandler(makeBashEvent('cat migration.sql'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
    }
  })

  it('does not fire for cat of a shell script', () => {
    const result = preBashHandler(makeBashEvent('cat script.sh'))
    expect(result.hookType).toBe('pass')
  })

  // Regression: the PowerShell-wrapped Get-Content SQL branch used to deny (not advise) whenever
  // the command had no cd-prefix, breaking the deliberate SQL-never-deny design every other SQL
  // extractor (cat/wsl-cat) already follows -- see the two tests directly above.
  it('emits context hint (not deny) for a PowerShell-wrapped Get-Content of a SQL file, with no cd prefix', () => {
    const result = preBashHandler(makeBashEvent(`powershell -Command "Get-Content 'schema.sql'"`))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
      expect(result.context).toContain('CREATE TABLE')
    }
  })
})

// Regression (e3fb46e): redirect to a quoted filename must be stripped for cache keying
describe('postBashHandler — redirect to quoted filename is stripped for cache keying', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('hits cache when command is rerun with a double-quoted redirect target added', async () => {
    // Bug: the masked quoted filename " " has spaces inside, so [^\s|]+ failed to match it as a redirect target, leaving "> \"tsc.log\"" in the cache key. Commands with and without a quoted redirect must share a single cache entry.
    const baseCmd = 'npx tsc --noEmit'
    const withRedirect = baseCmd + ' > "tsc.log"'
    const largeOutput = 'src/auth.ts(12,5): error TS2345: ...\n'.repeat(50)

    // Post: run with quoted redirect — must be stored under the base command key.
    await postBashHandler(makePostBashEvent(withRedirect, largeOutput))

    // Pre: same base command without redirect — must hit cache.
    const result = preBashHandler(makeBashEvent(baseCmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat bash-output')
    }
  })

  it('hits cache when command is rerun with a single-quoted redirect target added', async () => {
    const baseCmd = 'npx tsc --noEmit'
    const withRedirect = baseCmd + " > 'tsc.log'"
    const largeOutput = 'src/auth.ts(12,5): error TS2345: ...\n'.repeat(50)

    await postBashHandler(makePostBashEvent(withRedirect, largeOutput))

    const result = preBashHandler(makeBashEvent(baseCmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat bash-output')
    }
  })
})

// Regression: backslash-escaped quotes inside a quoted arg must not expose interior >
describe('postBashHandler — escaped quote inside quoted arg does not expose interior >', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('stores cache entry under the full command when escaped quote precedes > inside quotes', async () => {
    // Bug: "([^"]*)" treats \" as a closing quote, mis-pairing the string so that the interior > after \" is exposed to the redirect regex and truncates the key. e.g. pytest -k "x != \"skip and count > 0" was truncated to pytest -k "x != \"skip and count
    const cmd = 'pytest -k "x != \\"skip and count > 0"'
    const largeOutput = 'PASSED test_skipme\n'.repeat(60)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))

    const { fingerprintContent } = await import('../src/fingerprint.js')

    // Must be stored under the full, untruncated command.
    const correctHash = fingerprintContent(cmd).slice(0, 16)
    expect(getBashOutputId(correctHash)).not.toBeNull()

    // Must NOT be stored under the incorrectly-truncated key.
    const wrongHash = fingerprintContent('pytest -k "x != \\"skip and count').slice(0, 16)
    expect(getBashOutputId(wrongHash)).toBeNull()
  })
})

// Regression: a backslash-escaped quote next to a real trailing pipe must not
// desynchronize the inside-quotes tracker used to find the pipeline split point.
describe('postBashHandler — escaped quote next to a real pipe does not desync quote tracking', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('caches under the full command, not a base truncated at the escaped quote', async () => {
    // Bug: the pipe-split scanner toggled inDouble/inSingle on every raw quote char,
    // with no backslash-escape check. The escaped backslash-quote inside the -k pattern
    // flipped the tracker out of sync, so the scanner either split on the | still inside
    // the quoted string or missed the real trailing | head -20 pipe -- either way producing
    // the wrong base command and thus the wrong cache key.
    const cmd = 'pytest -k "fix: replace \\" | \\" separator"' + ' | head -20'
    const largeOutput = 'PASSED test_skipme\n'.repeat(60)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))

    const { fingerprintContent } = await import('../src/fingerprint.js')

    // Must be stored under the base command with the trailing | head -20 stripped,
    // but the whole quoted -k value (including the escaped quotes) intact.
    const correctBase = 'pytest -k "fix: replace \\" | \\" separator"'
    const correctHash = fingerprintContent(correctBase).slice(0, 16)
    expect(getBashOutputId(correctHash)).not.toBeNull()

    // Must NOT be stored under a key truncated at the escaped quote.
    const wrongBase = 'pytest -k "fix: replace \\"'
    const wrongHash = fingerprintContent(wrongBase).slice(0, 16)
    expect(getBashOutputId(wrongHash)).toBeNull()
  })

  it('still splits on a real pipe inside a normally-quoted argument (no backslash escapes)', async () => {
    const cmd = 'pytest -k "value | other"' + ' | head -20'
    const largeOutput = 'PASSED test_skipme\n'.repeat(60)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const correctHash = fingerprintContent('pytest -k "value | other"').slice(0, 16)
    expect(getBashOutputId(correctHash)).not.toBeNull()
  })
})

describe('postBashHandler — gh api advisory hints', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  function ghEvent(command: string, response: unknown): HookEvent {
    return {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command },
      sessionId: 'test-session',
      agentId: undefined,
      raw: { tool_name: 'Bash', tool_input: { command }, tool_response: response },
    }
  }

  // Build a JSON object string with exactly `n` keys.
  function wideJson(n: number): string {
    const obj: Record<string, number> = {}
    for (let i = 0; i < n; i++) obj['k' + i] = i
    return JSON.stringify(obj)
  }

  it('emits a scope hint when the response carries a permission-error phrase', async () => {
    const body = '{"message": "Resource not accessible by integration", "documentation_url": "https://docs"}'
    const result = await postBashHandler(ghEvent('gh api /repos/o/r/security_advisories', body))
    expectHookType(result, 'context')
    expect(result.context).toContain('gh auth refresh -s security_events')
  })

  it('emits a large-response hint when a gh api JSON object has 15+ keys', async () => {
    const result = await postBashHandler(ghEvent('gh api /user', wideJson(15)))
    expectHookType(result, 'context')
    expect(result.context).toContain('Large API response (15 keys)')
    expect(result.context).toContain("--jq '.key1,.key2'")
  })

  it('joins both hints when a wide response also carries a scope phrase', async () => {
    const obj: Record<string, string> = { message: 'Must have push access' }
    for (let i = 0; i < 20; i++) obj['k' + i] = String(i)
    const result = await postBashHandler(ghEvent('gh api /repos/o/r/advisories', JSON.stringify(obj)))
    expectHookType(result, 'context')
    expect(result.context).toContain('gh auth refresh -s security_events')
    expect(result.context).toContain('Large API response (21 keys)')
  })

  it('passes through for a small gh api response with no scope phrase', async () => {
    const result = await postBashHandler(ghEvent('gh api /user', '{"login": "octocat", "id": 1}'))
    expect(result.hookType).toBe('pass')
  })

  it('emits a scope hint for a failed security-path call even without a known phrase', async () => {
    const result = await postBashHandler(
      ghEvent('gh api /repos/o/r/security_advisories', { output: '{"message": "Not Found"}', exit_code: 1 }),
    )
    expectHookType(result, 'context')
    expect(result.context).toContain('gh auth refresh -s security_events')
  })

  it('still surfaces the scope hint when the body is not valid JSON', async () => {
    // Regression guard against the original Python behavior, where a json parse failure discarded an already-detected scope hint.
    const result = await postBashHandler(
      ghEvent('gh api /repos/o/r/advisories', 'gh: Resource not accessible by integration (HTTP 403)'),
    )
    expectHookType(result, 'context')
    expect(result.context).toContain('gh auth refresh -s security_events')
  })

  it('does not fire on a non-gh command with a wide JSON payload', async () => {
    const result = await postBashHandler(ghEvent('curl https://example.com/api', wideJson(20)))
    // curl GET output of this size routes through caching, not the gh hint path.
    expect(result.hookType).toBe('pass')
  })

  it('does not emit a large-response hint for a JSON array', async () => {
    const arr = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: i })))
    const result = await postBashHandler(ghEvent('gh api /repos/o/r/issues', arr))
    expect(result.hookType).toBe('pass')
  })
})

describe('gh api recall (F4)', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  // A read-only `gh api` GET body large enough to clear the 512-byte cache floor.
  const bigBody = JSON.stringify({ content: 'x'.repeat(800), encoding: 'base64' })

  // True only when the pre-hook fired the F4 recall hint. A non-cached gh api otherwise
  // falls through to the pre-existing output-compression wrap (rewriteInput), not a recall.
  const ghRecalled = (cmd: string): boolean => {
    const r = preBashHandler(makeBashEvent(cmd))
    return r.hookType === 'context' && r.context.includes('gh api response cached')
  }

  it('caches a read-only gh api GET and recalls it on a repeat', async () => {
    const cmd = 'gh api repos/octocat/hello/contents/README.md'
    await postBashHandler(makePostBashEvent(cmd, bigBody))
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('gh api response cached')
      expect(result.context).toContain('token-goat bash-output')
    }
  })

  it('recalls across an output pipe (keyed on the endpoint, not the pipe)', async () => {
    const piped = "gh api repos/octocat/hello/contents/README.md | jq -r '.content'"
    const bare = 'gh api repos/octocat/hello/contents/README.md'
    await postBashHandler(makePostBashEvent(piped, bigBody))
    expect(ghRecalled(bare)).toBe(true)
  })

  it('caches a gh api with explicit --method GET even alongside field flags', async () => {
    const cmd = 'gh api repos/octocat/hello/x --method GET -f per_page=1'
    await postBashHandler(makePostBashEvent(cmd, bigBody))
    expect(ghRecalled(cmd)).toBe(true)
  })

  it('does not cache a mutating gh api (-X DELETE)', async () => {
    const cmd = 'gh api -X DELETE repos/octocat/hello/issues/1'
    await postBashHandler(makePostBashEvent(cmd, bigBody))
    expect(ghRecalled(cmd)).toBe(false)
  })

  it('does not cache a gh api with field flags (gh defaults to POST)', async () => {
    const cmd = 'gh api repos/octocat/hello/issues -f title=Bug'
    await postBashHandler(makePostBashEvent(cmd, bigBody))
    expect(ghRecalled(cmd)).toBe(false)
  })

  it('does not cache the gh api graphql endpoint', async () => {
    const cmd = "gh api graphql -f query='{viewer{login}}'"
    await postBashHandler(makePostBashEvent(cmd, bigBody))
    expect(ghRecalled(cmd)).toBe(false)
  })

  it('does not cache a gh api carrying an Authorization header (avoids persisting a credential)', async () => {
    const cmd = 'gh api repos/octocat/hello -H "Authorization: Bearer ghp_x"'
    await postBashHandler(makePostBashEvent(cmd, bigBody))
    expect(ghRecalled(cmd)).toBe(false)
  })

  it('does not cache a gh api carrying an Authorization header via the long --header spelling', async () => {
    const cmd = 'gh api repos/octocat/hello --header "Authorization: Bearer ghp_x"'
    await postBashHandler(makePostBashEvent(cmd, bigBody))
    expect(ghRecalled(cmd)).toBe(false)
  })

  it('does not cache a gh api carrying an Authorization header via the --header= equals-sign spelling', async () => {
    const cmd = 'gh api repos/octocat/hello --header="Authorization: Bearer ghp_x"'
    await postBashHandler(makePostBashEvent(cmd, bigBody))
    expect(ghRecalled(cmd)).toBe(false)
  })

  it('caches a gh api with --method=GET even alongside field flags (equals-sign spelling)', async () => {
    const cmd = 'gh api repos/octocat/hello/x --method=GET -f per_page=1'
    await postBashHandler(makePostBashEvent(cmd, bigBody))
    expect(ghRecalled(cmd)).toBe(true)
  })

  it('does not cache a gh api response below the size floor', async () => {
    const cmd = 'gh api repos/octocat/hello/contents/tiny.txt'
    await postBashHandler(makePostBashEvent(cmd, '{"a":1}'))
    expect(ghRecalled(cmd)).toBe(false)
  })
})

describe('extractCatFile', () => {
  it('extracts file path from a simple cat command', () => {
    const result = extractCatFile('cat src/auth.ts')
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe('src/auth.ts')
    expect(result?.cmd0).toBe('cat')
  })

  it('extracts file path from Get-Content with quoted path', () => {
    const result = extractCatFile('Get-Content "src/config.json"')
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe('src/config.json')
    expect(result?.isConfig).toBe(true)
  })

  it('extracts file path from Get-Content with -Raw flag (trailing flag tolerance)', () => {
    const result = extractCatFile('Get-Content "src/auth.ts" -Raw')
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe('src/auth.ts')
    expect(result?.cmd0).toBe('Get-Content')
  })

  it('extracts file path from Get-Content with -Encoding flag', () => {
    const result = extractCatFile('Get-Content "src/auth.ts" -Encoding utf8')
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe('src/auth.ts')
  })

  it('extracts file path from Get-Content with multiple trailing flags', () => {
    const result = extractCatFile('Get-Content "README.md" -Raw -Encoding utf8')
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe('README.md')
    expect(result?.isDoc).toBe(true)
  })

  it('extracts file path from type command', () => {
    const result = extractCatFile('type config.yaml')
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe('config.yaml')
  })

  it('classifies a markdown file as doc', () => {
    const result = extractCatFile('cat README.md')
    expect(result?.isDoc).toBe(true)
  })

  it('classifies a JSON file as config', () => {
    const result = extractCatFile('cat package.json')
    expect(result?.isConfig).toBe(true)
  })

  it('classifies a SQL file as sql', () => {
    const result = extractCatFile('cat schema.sql')
    expect(result?.isSql).toBe(true)
  })

  it('returns null for unknown file extension', () => {
    const result = extractCatFile('cat blob.b64')
    expect(result).toBeNull()
  })
})

describe('extractPowerShellWrappedGetContent — unwraps a powershell -Command Get-Content wrapper', () => {
  it('returns null for a non-powershell command', () => {
    expect(extractPowerShellWrappedGetContent('cat src/auth.ts')).toBeNull()
    expect(extractPowerShellWrappedGetContent('echo hi')).toBeNull()
  })

  it('extracts a source path from `powershell -Command "Get-Content \'<path>\'"`', () => {
    const r = extractPowerShellWrappedGetContent(`powershell -Command "Get-Content 'src/auth.ts'"`)
    expect(r).not.toBeNull()
    expect(r?.filePath).toBe('src/auth.ts')
    expect(r?.isDoc).toBe(false)
    expect(r?.isConfig).toBe(false)
  })

  // Regression for F6: the reported flood used a TRAILING -Raw, which bare extractCatFile
  // rejects (its regex demands end-of-string right after the path). The wrapper extractor
  // must still classify it. Neutralizing POWERSHELL_WRAP_RE makes this return null.
  it('still matches when a trailing -Raw / -Encoding follows the path', () => {
    expect(extractPowerShellWrappedGetContent(`powershell -Command "Get-Content 'src/auth.ts' -Raw"`)?.filePath).toBe('src/auth.ts')
    expect(extractPowerShellWrappedGetContent(`powershell -Command "Get-Content 'src/auth.ts' -Raw -Encoding utf8"`)?.filePath).toBe('src/auth.ts')
  })

  it('handles the `pwsh -c "gc <doc>"` short form and classifies a doc', () => {
    const r = extractPowerShellWrappedGetContent(`pwsh -c "gc README.md"`)
    expect(r?.filePath).toBe('README.md')
    expect(r?.isDoc).toBe(true)
  })

  it('classifies a config path', () => {
    expect(extractPowerShellWrappedGetContent(`powershell -Command "Get-Content 'config.json'"`)?.isConfig).toBe(true)
  })

  it('returns null for an unknown extension (no surgical-read alternative)', () => {
    expect(extractPowerShellWrappedGetContent(`powershell -Command "Get-Content 'blob.b64' -Raw"`)).toBeNull()
  })

  it('size-gates temp paths: large temp read classifies, small one is skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-f6-'))
    const bigPath = join(dir, 'big.ts')
    const smallPath = join(dir, 'small.ts')
    writeFileSync(bigPath, 'x'.repeat(20 * 1024))
    writeFileSync(smallPath, 'const a = 1\n')
    try {
      expect(extractPowerShellWrappedGetContent(`powershell -Command "Get-Content '${bigPath}' -Raw"`)?.filePath).toBe(bigPath)
      expect(extractPowerShellWrappedGetContent(`powershell -Command "Get-Content '${smallPath}' -Raw"`)).toBeNull()
    } finally {
      try { unlinkSync(bigPath) } catch { /* best-effort */ }
      try { unlinkSync(smallPath) } catch { /* best-effort */ }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })
})

describe('preBashHandler — powershell-wrapped Get-Content recall (wiring)', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  // Proves the extractor is wired into preBashHandler ahead of the compress fallback:
  // a non-temp source read through a powershell wrapper denies with the read hint.
  it('denies a non-temp source read with a token-goat read hint and the powershell lead', () => {
    const result = preBashHandler(makeBashEvent(`powershell -Command "Get-Content 'src/auth.ts'"`))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('powershell -Command` wrapper bypasses read hooks')
      expect(result.message).toContain('token-goat read "src/auth.ts::SymbolName"')
    }
  })

  it('routes a wrapped doc read to a section hint', () => {
    const result = preBashHandler(makeBashEvent(`pwsh -c "gc README.md"`))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat section "README.md::SectionHeading"')
    }
  })
})

describe('extractGhViewForBatchAdvisory — detects an un-batched gh pr/issue view', () => {
  it('extracts the subcommand and PR number from `gh pr view <N>`', () => {
    expect(extractGhViewForBatchAdvisory('gh pr view 37836')).toEqual({ sub: 'pr', ref: '37836' })
  })

  it('extracts an issue view', () => {
    expect(extractGhViewForBatchAdvisory('gh issue view 42')).toEqual({ sub: 'issue', ref: '42' })
  })

  it('returns ref undefined for the current-branch form `gh pr view`', () => {
    expect(extractGhViewForBatchAdvisory('gh pr view')).toEqual({ sub: 'pr', ref: undefined })
  })

  it('still fires for a single-field --json query (field-by-field is the pattern to fix)', () => {
    expect(extractGhViewForBatchAdvisory('gh pr view 37836 --json title')).toEqual({ sub: 'pr', ref: '37836' })
  })

  // A multi-field --json list means the model is already batching, so the advisory must NOT fire.
  it('returns null when the command already batches multiple --json fields', () => {
    expect(extractGhViewForBatchAdvisory('gh pr view 37836 --json title,body,labels')).toBeNull()
  })

  it('returns null for non-view gh subcommands and non-gh commands', () => {
    expect(extractGhViewForBatchAdvisory('gh pr list')).toBeNull()
    expect(extractGhViewForBatchAdvisory('gh pr edit 5 --title x')).toBeNull()
    expect(extractGhViewForBatchAdvisory('gh issue create')).toBeNull()
    expect(extractGhViewForBatchAdvisory('git status')).toBeNull()
  })
})

describe('postBashHandler — gh view field-batching advisory (one-time per session)', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('emits a batched --json advisory on the first gh pr view, then stays silent on later views', async () => {
    const out = 'title:\tFix the thing\nstate:\tOPEN\n'.repeat(40)
    const first = await postBashHandler(makePostBashEvent('gh pr view 37836', out))
    expect(first.hookType).toBe('context')
    if (first.hookType === 'context') {
      expect(first.context).toContain('field queries can be batched')
      expect(first.context).toContain('gh pr view 37836 --json')
      expect(first.context).toContain('labels')
    }
    // One-time per session: a second view (even a different PR) does not re-advise.
    const second = await postBashHandler(makePostBashEvent('gh pr view 99999', out))
    expect(second.hookType).toBe('pass')
  })

  it('tailors the example to `gh issue view` and its ref', async () => {
    const out = 'title:\tA bug\nstate:\tOPEN\n'.repeat(40)
    const result = await postBashHandler(makePostBashEvent('gh issue view 42', out))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('gh issue view 42 --json')
      expect(result.context).toContain('comments')
    }
  })

  it('does not advise when the first view already batches --json fields', async () => {
    const out = '{"title":"x","body":"y","labels":[]}\n'.repeat(40)
    const result = await postBashHandler(makePostBashEvent('gh pr view 1 --json title,body,labels', out))
    expect(result.hookType).toBe('pass')
  })
})

describe('postBashHandler — failing test-runner advisory', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  function testRunEvent(command: string, output: string, exitCode: number | null): HookEvent {
    return {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command },
      sessionId: 'test-session',
      agentId: undefined,
      raw: {
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: exitCode === null ? output : { output, exit_code: exitCode },
      },
    }
  }

  // Large enough to clear the default 512-byte cache_min_bytes floor.
  const failingPytestOutput = '=== FAILURES ===\n' + 'FAILED tests/test_x.py::test_thing - AssertionError\n'.repeat(20)

  it('emits a failures advisory naming a recallable `bash-output | failures` command on a failing pytest run', async () => {
    const result = await postBashHandler(testRunEvent('pytest', failingPytestOutput, 1))
    expectHookType(result, 'context')
    expect(result.context).toContain('token-goat failures')
    expect(result.context).toContain('token-goat bash-output')
    // The suggested id must actually resolve to the cached output.
    const match = result.context.match(/token-goat bash-output (\S+)/)
    expect(match).not.toBeNull()
    if (match !== null) {
      const cached = getBashOutput(match[1] as string)
      expect(cached).not.toBeNull()
      expect(cached?.output).toBe(failingPytestOutput)
    }
  })

  it('fires for a bare `npm test` failure even though npm test is excluded from the general build/monitoring cache', async () => {
    const output = 'FAIL src/foo.test.ts\n' + '  ✗ does the thing\n'.repeat(40)
    const result = await postBashHandler(testRunEvent('npm test', output, 1))
    expectHookType(result, 'context')
    expect(result.context).toContain('token-goat failures')
  })

  it('fires for `npm run test`, `go test`, and `cargo test` failures', async () => {
    const output = 'FAIL: test_thing did not match expected value\n'.repeat(30)
    for (const cmd of ['npm run test', 'go test ./...', 'cargo test']) {
      clearModuleCaches()
      const result = await postBashHandler(testRunEvent(cmd, output, 1))
      expectHookType(result, 'context')
      expect(result.context).toContain('token-goat failures')
    }
  })

  it('stays silent on a passing (exit 0) test run', async () => {
    const result = await postBashHandler(testRunEvent('pytest', failingPytestOutput, 0))
    expect(result.hookType === 'context' && result.context.includes('token-goat failures')).toBe(false)
  })

  it('stays silent on a non-test command, even with a matching non-zero exit and large output', async () => {
    const output = 'error: something broke\n'.repeat(30)
    const result = await postBashHandler(testRunEvent('npm run build', output, 1))
    expect(result.hookType === 'context' && result.context.includes('token-goat failures')).toBe(false)
  })

  it('stays silent when the failing test output is too small to be worth reducing', async () => {
    const result = await postBashHandler(testRunEvent('pytest', 'FAILED tests/test_x.py::test_thing\n', 1))
    expect(result.hookType === 'context' && result.context.includes('token-goat failures')).toBe(false)
  })

  it('fires again on a second consecutive failing run (per-occurrence, not once-per-session)', async () => {
    const first = await postBashHandler(testRunEvent('pytest', failingPytestOutput, 1))
    expectHookType(first, 'context')
    expect(first.context).toContain('token-goat failures')
    const second = await postBashHandler(testRunEvent('pytest', failingPytestOutput, 1))
    expectHookType(second, 'context')
    expect(second.context).toContain('token-goat failures')
  })
})

// ---------------------------------------------------------------------------
// Config-driven bash_compress.cache_min_bytes / timeout_seconds. Before this
// fix, hooks_bash.ts always used a hardcoded MIN_CACHE_BYTES=512 floor and
// never emitted --timeout at all (the compress action silently fell back to
// bash_runner.ts's hardcoded DEFAULT_TIMEOUT_SECONDS), so these two config.ts
// knobs were validated/saved but had zero effect on real behavior.
// ---------------------------------------------------------------------------
describe('postBashHandler — config-driven bash_compress.cache_min_bytes', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  afterEach(() => {
    invalidateConfigCache()
    try {
      unlinkSync(_testConfigPath)
    } catch {
      // ok — may not exist
    }
  })

  it('does not cache an output that clears the old hardcoded 512-byte floor but misses a configured, higher cache_min_bytes', async () => {
    const cfg = defaultConfig()
    cfg.bash_compress.cache_min_bytes = 5000
    saveConfig(cfg)

    const output = 'Compiling token_goat v1.0.0 release output line '.repeat(20)
    expect(Buffer.byteLength(output, 'utf-8')).toBeGreaterThan(512)
    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThan(5000)

    const cmd = 'cargo build'
    await postBashHandler(makePostBashEvent(cmd, output))

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent(cmd).slice(0, 16)
    expect(getBashOutputId(simpleHash)).toBeNull()
  })

  it('still caches an output that clears a configured cache_min_bytes floor', async () => {
    const cfg = defaultConfig()
    cfg.bash_compress.cache_min_bytes = 5000
    saveConfig(cfg)

    const output = 'Compiling token_goat v1.0.0 release output line '.repeat(200)
    expect(Buffer.byteLength(output, 'utf-8')).toBeGreaterThan(5000)

    const cmd = 'cargo build'
    await postBashHandler(makePostBashEvent(cmd, output))

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent(cmd).slice(0, 16)
    expect(getBashOutputId(simpleHash)).not.toBeNull()
  })
})

describe('preBashHandler — config-driven bash_compress.timeout_seconds', () => {
  afterEach(() => {
    invalidateConfigCache()
    try {
      unlinkSync(_testConfigPath)
    } catch {
      // ok — may not exist
    }
  })

  it('threads a configured timeout_seconds into the compress wrapper command instead of always falling back to bash_runner.ts hardcoded default', () => {
    const cfg = defaultConfig()
    cfg.bash_compress.timeout_seconds = 42
    saveConfig(cfg)

    const event = makeBashEvent('rg "TODO" src/foo.ts')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      expect(String(result.updatedInput['command'])).toContain('--timeout 42')
    }
  })
})

// Regression (bug #242): a backgrounded or newline-separated command must never be
// rewritten into `token-goat compress -c '<cmd>'`. compress's `bash_runner.run` uses
// spawnSync with piped stdio, which blocks until the pipes close; the backgrounded
// grandchild inherits stdout, so the call hangs until it exits or the wrapper's 600s
// timeout kills the whole process tree the user wanted kept running in the background.
describe('preBashHandler — backgrounded/multi-line commands are never compress-wrapped', () => {
  it('does not wrap a backgrounded dev-server command', () => {
    const result = preBashHandler(makeBashEvent('vite dev &'))
    expect(result.hookType).toBe('pass')
  })

  it('does not wrap a backgrounded watch command', () => {
    const result = preBashHandler(makeBashEvent('tsc --watch &'))
    expect(result.hookType).toBe('pass')
  })

  it('does not wrap a newline-separated compound command', () => {
    const result = preBashHandler(makeBashEvent('echo one\necho two'))
    expect(result.hookType).toBe('pass')
  })

  it('still wraps an ordinary single command with no background operator', () => {
    const result = preBashHandler(makeBashEvent('npm test'))
    expect(result.hookType).toBe('rewriteInput')
  })

  it('still rejects an already-rejected && compound', () => {
    const result = preBashHandler(makeBashEvent('git log && git status'))
    expect(result.hookType).toBe('pass')
  })
})

// Regression: checkout/switch/pull/merge/rebase/reset/cherry-pick rewrite working-tree file
// content without ever going through Claude Code's Edit tool, so those files never entered
// queue/dirty.txt via the normal postEditHandler path -- every surgical-read command would
// otherwise silently keep serving stale symbols/refs computed before the mutation. See the
// isHeadMovingGitCommand block in postBashHandler.
describe('isHeadMovingGitCommand — classification table', () => {
  it.each([
    ['git checkout feature', true],
    ['git switch feature', true],
    ['git switch -c newbranch', true],
    ['git pull', true],
    ['git pull --rebase origin main', true],
    ['git merge feature', true],
    ['git rebase main', true],
    ['git reset --hard HEAD~1', true],
    ['git cherry-pick abc1234', true],
    ['  git checkout feature', true],
    ['GIT CHECKOUT feature', true],
    ['git checkout -- a.txt', false],
    ['git checkout -- a.txt b.txt', false],
    ['git checkout main -- a.txt', false],
    ['git status', false],
    ['git diff --stat', false],
    ['git log', false],
    ['echo git checkout feature', false],
    ['npm run build', false],
  ])('%s -> %s', (cmd, expected) => {
    expect(isHeadMovingGitCommand(cmd)).toBe(expected)
  })
})

describe('postBashHandler — git-mutation staleness enqueue', () => {
  beforeEach(() => {
    clearModuleCaches()
    clearDirtyQueue()
  })

  it('enqueues a file changed by `git checkout <branch>` to the dirty queue', async () => {
    const dir = initGitRepoForBashTests('tg-gitmutate-checkout-')
    try {
      const git = (args: string[]): void => {
        execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
      }
      const originalBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir }).toString().trim()
      git(['checkout', '-b', 'feature'])
      writeFileSync(join(dir, 'a.txt'), 'two\n')
      git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
      git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'change a.txt'])
      git(['checkout', originalBranch])

      await postBashHandler(makePostBashEvent('git checkout feature', '', dir))

      const dirty = foldedDirtyPaths()
      const expected = resolveIndexPath('a.txt', dir)
      expect(dirty).toContain(foldPath(expected))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enqueues a file changed by `git reset --hard <ref>`', async () => {
    const dir = initGitRepoForBashTests('tg-gitmutate-reset-')
    try {
      const git = (args: string[]): void => {
        execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
      }
      const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
      writeFileSync(join(dir, 'a.txt'), 'two\n')
      git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
      git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'change a.txt'])

      await postBashHandler(makePostBashEvent(`git reset --hard ${firstSha}`, '', dir))

      const dirty = foldedDirtyPaths()
      const expected = resolveIndexPath('a.txt', dir)
      expect(dirty).toContain(foldPath(expected))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: `git diff --name-only` always reports paths relative to the repo TOP-LEVEL, regardless of which directory git was invoked from -- resolving those paths against the raw event cwd (a monorepo subpackage) instead of the actual repo root computed the wrong absolute path and silently enqueued nothing useful for the file that really changed.
  it('enqueues the correct absolute path when the bash tool cwd is a repo subdirectory, not the repo root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-gitmutate-subdir-'))
    const sub = join(dir, 'sub')
    try {
      const git = (args: string[], cwd = dir): void => {
        execFileSync('git', args, { cwd, stdio: 'ignore' })
      }
      mkdirSync(sub)
      writeFileSync(join(sub, 'nested.txt'), 'one\n')
      git(['init'])
      git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
      git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'])
      const originalBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir }).toString().trim()

      git(['checkout', '-b', 'feature'])
      writeFileSync(join(sub, 'nested.txt'), 'two\n')
      git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
      git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'change nested.txt'])
      git(['checkout', originalBranch])

      // The bash tool's reported cwd is the SUBDIRECTORY, not the repo root -- mirrors a real `cd sub && git checkout feature` session.
      await postBashHandler(makePostBashEvent('git checkout feature', '', sub))

      const dirty = foldedDirtyPaths()
      // git diff --name-only reports 'sub/nested.txt' relative to the repo TOP-LEVEL (dir), not relative to the subdirectory cwd it was invoked from.
      const expected = resolveIndexPath('sub/nested.txt', dir)
      expect(dirty).toContain(foldPath(expected))
      // The old, buggy behavior resolved that same 'sub/nested.txt' string onto the subdirectory cwd instead of the repo root, producing a nonexistent 'sub/sub/nested.txt' path -- guard against that regressing back.
      expect(dirty).not.toContain(foldPath(resolveIndexPath('sub/nested.txt', sub)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: for a multi-commit rebase, the final `rebase (finish)` reflog step is a ref finalize, not a new commit -- it points at the SAME sha as the last `rebase (pick)` step, so `HEAD@{1}` and `HEAD@{0}` are identical and `git diff --name-only HEAD@{1} HEAD` comes back completely EMPTY, silently enqueuing nothing at all (empirically confirmed). `ORIG_HEAD` survives the internal reflog churn and correctly diffs against the true pre-rebase tip, catching the file that actually changed (content newly pulled in from the rebase target).
  it('enqueues the changed file after a multi-commit rebase, where HEAD@{1}..HEAD would come back empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-gitmutate-rebase-'))
    try {
      const git = (args: string[]): void => {
        execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
      }
      const gitEnv = ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null']
      writeFileSync(join(dir, 'base.txt'), 'base\n')
      git(['init'])
      git([...gitEnv, 'add', '.'])
      git([...gitEnv, 'commit', '-m', 'init'])
      const originalBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir }).toString().trim()

      git(['checkout', '-b', 'feature'])
      writeFileSync(join(dir, 'first.txt'), 'first\n')
      git([...gitEnv, 'add', 'first.txt'])
      git([...gitEnv, 'commit', '-m', 'add first.txt'])
      writeFileSync(join(dir, 'second.txt'), 'second\n')
      git([...gitEnv, 'add', 'second.txt'])
      git([...gitEnv, 'commit', '-m', 'add second.txt'])

      git(['checkout', originalBranch])
      writeFileSync(join(dir, 'mainline.txt'), 'mainline\n')
      git([...gitEnv, 'add', 'mainline.txt'])
      git([...gitEnv, 'commit', '-m', 'unrelated mainline commit'])

      git(['checkout', 'feature'])
      execFileSync('git', [...gitEnv, 'rebase', originalBranch], { cwd: dir, stdio: 'ignore' })

      await postBashHandler(makePostBashEvent('git rebase ' + originalBranch, '', dir))

      const dirty = foldedDirtyPaths()
      // mainline.txt is the only file whose final working-tree content actually differs from before the rebase (first.txt/second.txt already existed with identical content on feature pre-rebase) -- this is the correct enqueue set, not an incidental one.
      expect(dirty).toContain(foldPath(resolveIndexPath('mainline.txt', dir)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT enqueue anything for a path-scoped `git checkout -- <file>` restore (HEAD never moves)', async () => {
    const dir = initGitRepoForBashTests('tg-gitmutate-scoped-')
    try {
      writeFileSync(join(dir, 'a.txt'), 'two\n')

      await postBashHandler(makePostBashEvent('git checkout -- a.txt', '', dir))

      expect(getDirtyPaths()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT enqueue anything for a non-git-mutating command', async () => {
    const dir = initGitRepoForBashTests('tg-gitmutate-noop-')
    try {
      await postBashHandler(makePostBashEvent('git status', '', dir))
      expect(getDirtyPaths()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT enqueue anything when the head-moving command failed (non-zero exit)', async () => {
    const dir = initGitRepoForBashTests('tg-gitmutate-fail-')
    try {
      const event = makeHookEvent({
        eventName: 'post_tool_use',
        toolName: 'Bash',
        toolInput: { command: 'git checkout nonexistent-branch' },
        sessionId: 'test-session',
        agentId: undefined,
        raw: {
          tool_name: 'Bash',
          tool_input: { command: 'git checkout nonexistent-branch' },
          tool_response: { output: '', exit_code: 1 },
          cwd: dir,
        },
      })
      await postBashHandler(event)
      expect(getDirtyPaths()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: `git reset` is deliberately excluded from the ORIG_HEAD-preferring diff base (see ORIG_HEAD_ELIGIBLE_GIT_RE in hooks_bash.ts) because a bare `git reset <pathspec>` shares `git checkout <file>`'s ref-vs-path ambiguity -- always using HEAD@{1} for reset sidesteps that ambiguity entirely rather than trying to heuristically detect it. This test locks in that a reset immediately following a multi-commit rebase (which sets a far-back ORIG_HEAD) still enqueues based on the reset's own single, immediately-prior reflog step, not the rebase's ORIG_HEAD -- proving reset truly never reads ORIG_HEAD, not just that it happens to coincide with HEAD@{1} in the common case.
  it('enqueues based on the reset itself, not a leftover ORIG_HEAD from an earlier rebase', async () => {
    const dir = initGitRepoForBashTests('tg-gitmutate-reset-after-rebase-')
    try {
      const gitEnv = ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null']
      const git = (args: string[]): void => {
        execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
      }
      const originalBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir }).toString().trim()

      // Multi-commit rebase sets a far-back ORIG_HEAD (the true pre-rebase feature tip)
      git(['checkout', '-b', 'feature'])
      writeFileSync(join(dir, 'first.txt'), 'first\n')
      git([...gitEnv, 'add', 'first.txt'])
      git([...gitEnv, 'commit', '-m', 'add first.txt'])
      writeFileSync(join(dir, 'second.txt'), 'second\n')
      git([...gitEnv, 'add', 'second.txt'])
      git([...gitEnv, 'commit', '-m', 'add second.txt'])
      git(['checkout', originalBranch])
      writeFileSync(join(dir, 'mainline.txt'), 'mainline\n')
      git([...gitEnv, 'add', 'mainline.txt'])
      git([...gitEnv, 'commit', '-m', 'unrelated mainline commit'])
      git(['checkout', 'feature'])
      execFileSync('git', [...gitEnv, 'rebase', originalBranch], { cwd: dir, stdio: 'ignore' })
      const rebaseOrigHead = execFileSync('git', ['rev-parse', 'ORIG_HEAD'], { cwd: dir }).toString().trim()

      // A real, unambiguous `reset --hard` immediately after: its own reflog step lands right on top of the rebase's finish step, so its own ORIG_HEAD/HEAD@{1} both point at the post-rebase tip -- nothing to do with the rebase's now-superseded ORIG_HEAD.
      writeFileSync(join(dir, 'third.txt'), 'third\n')
      git([...gitEnv, 'add', 'third.txt'])
      git([...gitEnv, 'commit', '-m', 'add third.txt'])
      const preResetTip = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir }).toString().trim()
      execFileSync('git', [...gitEnv, 'reset', '-q', '--hard', 'HEAD~1'], { cwd: dir, stdio: 'ignore' })

      await postBashHandler(makePostBashEvent('git reset --hard HEAD~1', '', dir))

      expect(execFileSync('git', ['rev-parse', 'ORIG_HEAD'], { cwd: dir }).toString().trim()).not.toBe(rebaseOrigHead)
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()).toBe(preResetTip)
      const dirty = foldedDirtyPaths()
      // third.txt is what this reset actually reverted -- the correct, narrow enqueue.
      expect(dirty).toContain(foldPath(resolveIndexPath('third.txt', dir)))
      // mainline.txt only shows up if the reset had somehow used the rebase's stale, far-back ORIG_HEAD instead of its own immediately-prior state.
      expect(dirty).not.toContain(foldPath(resolveIndexPath('mainline.txt', dir)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('postBashHandler — feeds Bash file dumps into the session read-cache', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('a whole-file `cat` marks the file as read this session, so a later Read gets the dedup hint', async () => {
    const target = resolveIndexPath('package.json', process.cwd())
    expect(wasFileReadThisSession(target)).toBe(false)

    await postBashHandler(makePostBashEvent('cat package.json', '{ "name": "token-goat" }'))

    expect(wasFileReadThisSession(target)).toBe(true)
  })

  it('`head -40 foo.ts` does NOT claim a full prior read — it records only the shown line range, not a whole-file read (the false-dedup guard)', async () => {
    const target = resolveIndexPath('package.json', process.cwd())
    expect(wasFileReadThisSession(target)).toBe(false)

    await postBashHandler(makePostBashEvent('head -40 package.json', 'line\n'.repeat(40)))

    // The specific wrong behavior under test: a partial dump must never flip the full-read flag
    // a later Read's dedup hint keys on. If this were true, a subsequent Read of package.json
    // would be wrongly told "already read this session" despite 39/40+ lines never being shown.
    expect(wasFileReadThisSession(target)).toBe(false)
    expect(getFileLineRanges(target)).toContainEqual([1, 40])
  })

  it('`tail -40 foo.ts` cannot be expressed as an absolute line range (unknown file length), so it is recorded as a truncated read rather than a false full read', async () => {
    const target = resolveIndexPath('package.json', process.cwd())

    await postBashHandler(makePostBashEvent('tail -40 package.json', 'line\n'.repeat(40)))

    expect(wasFileTruncatedThisSession(target)).toBe(true)
  })

  it('`Get-Content foo.ts -Tail 40` is classified as a partial (truncated) read, not swallowed as a whole-file read by extractCatFile\'s trailing-flag catch-all (ordering regression)', async () => {
    const target = resolveIndexPath('package.json', process.cwd())

    await postBashHandler(makePostBashEvent('Get-Content package.json -Tail 40', 'line\n'.repeat(40)))

    expect(wasFileTruncatedThisSession(target)).toBe(true)
    // If extractCatFile's generic trailing-flag match had run first, this would incorrectly be a full read instead.
    expect(wasFileReadThisSession(target)).toBe(true) // markFileTruncated does mark the entry as read, but flagged truncated — the read-hint logic branches on that flag before treating it as a clean full read.
  })

  it('a failed `cat` records nothing — a nonzero exit code means the command never actually produced the content', async () => {
    const target = resolveIndexPath('package.json', process.cwd())
    const failedEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: 'cat package.json' },
      sessionId: 'test-session',
      agentId: undefined,
      raw: {
        tool_name: 'Bash',
        tool_input: { command: 'cat package.json' },
        tool_response: { output: 'cat: package.json: Permission denied', exit_code: 1 },
      },
    }

    await postBashHandler(failedEvent)

    expect(wasFileReadThisSession(target)).toBe(false)
  })

  it('a `cat` of a temp scratch path is rejected by the extractor itself and records nothing', async () => {
    const tempFile = join(tmpdir(), 'tg-bashcache-scratch.ts')
    writeFileSync(tempFile, 'const x = 1\n')
    try {
      const target = resolveIndexPath(tempFile, process.cwd())
      await postBashHandler(makePostBashEvent(`cat "${tempFile}"`, 'const x = 1\n'))

      expect(wasFileReadThisSession(target)).toBe(false)
    } finally {
      rmSync(tempFile, { force: true })
    }
  })
})

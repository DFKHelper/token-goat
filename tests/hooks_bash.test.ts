import { describe, it, expect, beforeEach } from 'vitest'
import type { HookEvent } from '../src/hook_registry.js'
import { postBashHandler, preBashHandler, extractCurlDownload, extractMarkdownHeadingGrep, extractRgSymbolSearch, extractPowerShellWrappedGetContent, extractGhViewForBatchAdvisory } from '../src/hooks_bash.js'
import { getBashOutputId, recordFileRead } from '../src/session.js'
import { getBashOutputByCommandHash } from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'
import { resolveIndexPath } from '../src/paths.js'
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makePostBashEvent(command: string, output: string, cwd?: string): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
    raw: {
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: output,
      ...(cwd !== undefined ? { cwd } : {}),
    },
  }
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
    const entry = getBashOutputByCommandHash(id!)
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
  return {
    eventName: 'pre_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
    raw: cwd !== undefined ? { cwd } : {},
  }
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
      raw: { tool_response: largeOutput },
    })

    // Pre handler should emit the tailored recall message
    const result = preBashHandler({
      eventName: 'pre_tool_use',
      toolName: 'Bash',
      toolInput: { command: cmd },
      sessionId: 's',
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
      raw: {},
    })
    expect(result.hookType).toBe('pass')
  })

  it('denies cat of a Java source file', () => {
    const event = makeBashEvent('cat /c/Projects/repo/src/main/java/Foo.java')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('deny')
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
    expect(result.hookType).toBe('deny')
    expect(result.message).toContain('config-get')
  })

  it('denies cat of a .env.local file', () => {
    const result = preBashHandler(makeBashEvent('cat /app/.env.local'))
    expect(result.hookType).toBe('deny')
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

  it('emits advisory context for head command on SQL file', () => {
    const result = preBashHandler(makeBashEvent('head -10 supabase/migrations/0001_init.sql'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
    }
  })

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
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Get-Content -Tail')
      expect(result.context).toContain('token-goat')
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
    expect(result.hookType).toBe('pass')
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
    const result = preBashHandler(makeBashEvent('cat /home/user/.claude/tasks/abc123def456.output'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      // The recall command must name the on-disk path via --file; a bare `bash-output <id>` misses the cache (task id is not a cache key), and the old "already cached" wording promised a recall that errored.
      expect(result.message).toContain('token-goat bash-output --file "/home/user/.claude/tasks/abc123def456.output"')
      expect(result.message).toContain('--transcript')
      expect(result.message).toContain('--tail 50')
      expect(result.message).not.toContain('already cached')
    }
  })

  it('denies tail on a tasks output path and preserves the requested line count', () => {
    const result = preBashHandler(makeBashEvent('tail -n 20 /home/user/.claude/tasks/abc123def456.output'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output --file "/home/user/.claude/tasks/abc123def456.output"')
      expect(result.message).toContain('--tail 20')
    }
  })

  it('denies cat with Windows-style backslash tasks path', () => {
    const result = preBashHandler(makeBashEvent('cat C:\\Users\\user\\.claude\\tasks\\def789.output'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output --file "C:\\Users\\user\\.claude\\tasks\\def789.output"')
    }
  })

  it('passes through cat on a non-tasks temp file', () => {
    const result = preBashHandler(makeBashEvent('cat /tmp/somefile.output'))
    expect(result.hookType).toBe('pass')
  })

  it('denies tail -c byte-mode on a tasks output path', () => {
    const result = preBashHandler(makeBashEvent('tail -c 1500 /home/user/.claude/tasks/abc123def456.output'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output --file "/home/user/.claude/tasks/abc123def456.output"')
      expect(result.message).not.toContain('already cached')
    }
  })

  it('denies tail -c on a Windows-style tasks output path', () => {
    const result = preBashHandler(makeBashEvent('tail -c 2000 C:\\Users\\user\\.claude\\tasks\\bb9912.output'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output --file "C:\\Users\\user\\.claude\\tasks\\bb9912.output"')
    }
  })

  it('passes through tail -c on a non-tasks output file', () => {
    const result = preBashHandler(makeBashEvent('tail -c 1500 /tmp/build.output'))
    expect(result.hookType).toBe('pass')
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
      writeFileSync(v1Path, '{}')
      const url = 'https://example.com/report.json'
      const firstCmd = `curl ${url} -o ${v1Path}`
      await postBashHandler(makePostBashEvent(firstCmd, ''))

      const v2Path = join(dir, 'report-v2.json')
      const secondCmd = `curl ${url} -o ${v2Path}`
      const result = preBashHandler(makeBashEvent(secondCmd))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain(v1Path)
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
      writeFileSync(outPath, '#!/bin/sh\necho hi\n')
      const cmd = `curl https://example.com/script.sh -o ${outPath}`
      await postBashHandler(makePostBashEvent(cmd, ''))
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('deny')
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
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
    expect(result.hookType).toBe('context')
    expect(result.context).toContain('gh auth refresh -s security_events')
  })

  it('emits a large-response hint when a gh api JSON object has 15+ keys', async () => {
    const result = await postBashHandler(ghEvent('gh api /user', wideJson(15)))
    expect(result.hookType).toBe('context')
    expect(result.context).toContain('Large API response (15 keys)')
    expect(result.context).toContain("--jq '.key1,.key2'")
  })

  it('joins both hints when a wide response also carries a scope phrase', async () => {
    const obj: Record<string, string> = { message: 'Must have push access' }
    for (let i = 0; i < 20; i++) obj['k' + i] = String(i)
    const result = await postBashHandler(ghEvent('gh api /repos/o/r/advisories', JSON.stringify(obj)))
    expect(result.hookType).toBe('context')
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
    expect(result.hookType).toBe('context')
    expect(result.context).toContain('gh auth refresh -s security_events')
  })

  it('still surfaces the scope hint when the body is not valid JSON', async () => {
    // Regression guard against the original Python behavior, where a json parse failure discarded an already-detected scope hint.
    const result = await postBashHandler(
      ghEvent('gh api /repos/o/r/advisories', 'gh: Resource not accessible by integration (HTTP 403)'),
    )
    expect(result.hookType).toBe('context')
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

  it('does not cache a gh api response below the size floor', async () => {
    const cmd = 'gh api repos/octocat/hello/contents/tiny.txt'
    await postBashHandler(makePostBashEvent(cmd, '{"a":1}'))
    expect(ghRecalled(cmd)).toBe(false)
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

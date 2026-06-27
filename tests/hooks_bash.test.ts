import { describe, it, expect, beforeEach } from 'vitest'
import type { HookEvent } from '../src/hook_registry.js'
import { postBashHandler, preBashHandler } from '../src/hooks_bash.js'
import { getBashOutputId } from '../src/session.js'
import { getBashOutputByCommandHash } from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'

function makePostBashEvent(command: string, output: string): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
    raw: {
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: output,
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

function makeBashEvent(command: string): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
    raw: {},
  }
}

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

  it('denies cat of a SQL migration file', () => {
    const result = preBashHandler(makeBashEvent('cat supabase/migrations/0001_init.sql'))
    expect(result.hookType).toBe('deny')
    expect(result.message).toContain('token-goat section')
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

  it('passes through rg searching for a non-structural pattern', () => {
    const event = makeBashEvent('rg "TODO" src/token_goat/compact.py')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('passes through rg structural search on a directory (not a single file)', () => {
    const event = makeBashEvent('rg "^def" src/token_goat/')
    const result = preBashHandler(event)
    expect(result.hookType).toBe('pass')
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

  it('denies cat of a tasks output path and emits bash-output hint', () => {
    const result = preBashHandler(makeBashEvent('cat /home/user/.claude/tasks/abc123def456.output'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output abc123def456')
      expect(result.message).toContain('already cached')
    }
  })

  it('denies tail on a tasks output path and emits bash-output hint', () => {
    const result = preBashHandler(makeBashEvent('tail -n 50 /home/user/.claude/tasks/abc123def456.output'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output abc123def456')
    }
  })

  it('denies cat with Windows-style backslash tasks path', () => {
    const result = preBashHandler(makeBashEvent('cat C:\\Users\\user\\.claude\\tasks\\def789.output'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output def789')
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
      expect(result.message).toContain('token-goat bash-output abc123def456')
      expect(result.message).toContain('already cached')
    }
  })

  it('denies tail -c on a Windows-style tasks output path', () => {
    const result = preBashHandler(makeBashEvent('tail -c 2000 C:\\Users\\user\\.claude\\tasks\\bb9912.output'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat bash-output bb9912')
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

  it('emits section hint for sed -n line range extraction', () => {
    const result = preBashHandler(makeBashEvent("sed -n '10,50p' src/hooks_read.ts"))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
    }
  })

  it('emits section hint for sed -n with double-quoted range', () => {
    const result = preBashHandler(makeBashEvent('sed -n "100,200p" README.md'))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
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

  it('passes through plain eza without --long flag', () => {
    const result = preBashHandler(makeBashEvent('eza src/'))
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

  it('passes through first curl GET (nothing cached yet)', () => {
    const result = preBashHandler(makeBashEvent('curl -s https://api.example.com/data'))
    expect(result.hookType).toBe('pass')
  })

  it('does not cache curl POST', async () => {
    const cmd = 'curl -X POST -d \'{"key":"val"}\' https://api.example.com/create'
    const largeOutput = '{"id":1}'.repeat(200)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))
    // POST should not be cached, so pre-handler passes
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('pass')
  })

  it('does not cache curl with auth headers', async () => {
    const cmd = "curl -s -H 'Authorization: Bearer token123' https://api.example.com/me"
    const largeOutput = '{"user":"me"}'.repeat(200)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('pass')
  })

  it('does not cache curl with -u credentials', async () => {
    const cmd = 'curl -s -u admin:password https://api.example.com/admin'
    const largeOutput = '{"admin":true}'.repeat(200)
    await postBashHandler(makePostBashEvent(cmd, largeOutput))
    const result = preBashHandler(makeBashEvent(cmd))
    expect(result.hookType).toBe('pass')
  })
})

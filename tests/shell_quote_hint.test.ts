import { describe, it, expect, beforeEach } from 'vitest'
import { preBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { invalidateConfigCache, loadConfig } from '../src/config.js'
import type { HookEvent } from '../src/hook_registry.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { expectHookType } from './helpers/hook-output.js'

function makeBashEvent(command: string): HookEvent {
  return makeHookEvent({
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
  })
}

describe('preBashHandler — shell quote hint', () => {
  beforeEach(() => {
    clearModuleCaches()
    invalidateConfigCache()
  })

  describe('balanced quotes and valid heredocs', () => {
    it('passes through commands with balanced single quotes', () => {
      const result = preBashHandler(makeBashEvent("echo 'hello world'"))
      // May be rewriteInput if it hits compress path, but should not have quote hint
      expect(result.hookType).not.toBe('context')
    })

    it('passes through commands with balanced double quotes', () => {
      const result = preBashHandler(makeBashEvent('echo "hello world"'))
      expect(result.hookType).not.toBe('context')
    })

    it('does NOT flag single quote inside double quotes (common case)', () => {
      const result = preBashHandler(makeBashEvent('git commit -m "don\'t forget"'))
      // git is a build command so it may compress, but should not have quote hint
      expect(result.hookType).not.toBe('context')
    })

    it('passes through mixed single and double quotes when balanced', () => {
      const result = preBashHandler(makeBashEvent("echo \"it's a test\" && echo 'done'"))
      expect(result.hookType).not.toBe('context')
    })

    it('passes through commands with properly terminated heredoc (<<EOF)', () => {
      const cmd = `cat <<EOF
line 1
line 2
EOF`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })

    it('passes through commands with indented heredoc (<<-EOF)', () => {
      const cmd = `cat <<-EOF
  line 1
  line 2
  EOF`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })

    it('passes through commands with quoted heredoc delimiter (<<\'EOF\')', () => {
      const cmd = `cat <<'EOF'
literal $VAR and $ escape
EOF`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })

    it('passes through commands with double-quoted heredoc delimiter (<<"EOF")', () => {
      const cmd = `cat <<"EOF"
with expansion
EOF`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })

    it('passes through multiple heredocs in one command', () => {
      const cmd = `cat <<EOF1
content 1
EOF1
cat <<EOF2
content 2
EOF2`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })

    it('does NOT flag an unmatched apostrophe inside a heredoc body (contraction in prose)', () => {
      const cmd = `cat <<EOF
it's a test
EOF
echo "done"`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })

    it('does NOT flag an unmatched apostrophe inside an indented (<<-) heredoc body', () => {
      const cmd = `cat <<-EOF
  don't stop believing
  EOF`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })

    it('passes through command with awk using single quotes', () => {
      const result = preBashHandler(makeBashEvent("awk '{print $1}' file.txt"))
      expect(result.hookType).toBe('pass')
    })

    it('passes through complex shell pipeline with balanced quotes', () => {
      const result = preBashHandler(
        makeBashEvent('grep "pattern" file.txt | awk \'{print $2}\' | sort'),
      )
      expect(result.hookType).toBe('pass')
    })
  })

  describe('unbalanced single quotes', () => {
    it('emits context hint for unclosed single quote', () => {
      const result = preBashHandler(makeBashEvent("echo 'hello"))
      expectHookType(result, 'context')
      expect(result.context).toContain('unclosed single quote')
      expect(result.context).toContain('Write tool')
    })

    it('emits hint even with other content after unclosed quote', () => {
      const result = preBashHandler(makeBashEvent("echo 'hello && something else"))
      expectHookType(result, 'context')
      expect(result.context).toContain('unclosed single quote')
    })

    it('detects odd number of single quotes in isolation', () => {
      const result = preBashHandler(makeBashEvent("echo ' a ' b '"))
      expectHookType(result, 'context')
      expect(result.context).toContain('unclosed single quote')
    })
  })

  describe('unbalanced double quotes', () => {
    it('emits context hint for unclosed double quote', () => {
      const result = preBashHandler(makeBashEvent('echo "hello'))
      expectHookType(result, 'context')
      expect(result.context).toContain('unclosed double quote')
      expect(result.context).toContain('Write tool')
    })

    it('emits hint for unclosed double quote with escaped content', () => {
      const result = preBashHandler(makeBashEvent('echo "hello \\"world'))
      expectHookType(result, 'context')
      expect(result.context).toContain('unclosed double quote')
    })

    it('correctly handles escaped quotes inside double quotes', () => {
      // Escaped quote should not be treated as a delimiter
      const result = preBashHandler(makeBashEvent('echo "hello \\" world"'))
      expect(result.hookType).not.toBe('context')
    })

    it('correctly handles literal backslashes in double quotes', () => {
      // In shell: \\ is an escaped backslash (produces literal \), followed by space and word and closing quote
      const result = preBashHandler(makeBashEvent('echo "hello \\\\ world"'))
      expect(result.hookType).not.toBe('context')
    })
  })

  describe('unterminated heredocs', () => {
    it('emits context hint for unterminated heredoc without terminator line', () => {
      const cmd = `cat <<EOF
line 1
line 2`
      const result = preBashHandler(makeBashEvent(cmd))
      expectHookType(result, 'context')
      expect(result.context).toContain('unterminated heredoc')
      expect(result.context).toContain('EOF')
    })

    it('detects unterminated <<- heredoc', () => {
      const cmd = `cat <<-EOF
  indented line
  another line`
      const result = preBashHandler(makeBashEvent(cmd))
      expectHookType(result, 'context')
      expect(result.context).toContain('unterminated heredoc')
    })

    it('requires exact match for heredoc terminator (case-sensitive)', () => {
      const cmd = `cat <<EOF
content
eof`
      const result = preBashHandler(makeBashEvent(cmd))
      expectHookType(result, 'context')
      expect(result.context).toContain('unterminated heredoc')
    })

    it('detects indented terminator without <<- modifier as unterminated', () => {
      // Without <<-, the terminator must not be indented
      const cmd = `cat <<EOF
content
  EOF`
      const result = preBashHandler(makeBashEvent(cmd))
      // This is unterminated because "  EOF" with leading spaces doesn't exactly match "EOF"
      expectHookType(result, 'context')
      expect(result.context).toContain('unterminated heredoc')
    })

    it('allows whitespace before heredoc terminator with <<- modifier', () => {
      const cmd = `cat <<-EOF
content
  EOF`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })
  })

  describe('config flag: warn_unbalanced_shell_quoting', () => {
    it('respects config flag when disabled (TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING=false)', () => {
      const orig = process.env['TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING']
      try {
        process.env['TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING'] = 'false'
        invalidateConfigCache()
        clearModuleCaches()
        const result = preBashHandler(makeBashEvent("echo 'unclosed"))
        expect(result.hookType).toBe('pass')
      } finally {
        if (orig === undefined) {
          delete process.env['TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING']
        } else {
          process.env['TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING'] = orig
        }
        invalidateConfigCache()
        clearModuleCaches()
      }
    })

    it('defaults to true (enabled)', () => {
      // Ensure the env var is not set
      const orig = process.env['TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING']
      try {
        delete process.env['TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING']
        invalidateConfigCache()
        clearModuleCaches()
        const cfg = loadConfig()
        expect(cfg.hints.warn_unbalanced_shell_quoting).toBe(true)
      } finally {
        if (orig !== undefined) {
          process.env['TOKEN_GOAT_WARN_UNBALANCED_SHELL_QUOTING'] = orig
        }
        invalidateConfigCache()
        clearModuleCaches()
      }
    })
  })

  describe('edge cases and robustness', () => {
    it('passes through empty command', () => {
      const result = preBashHandler(makeBashEvent(''))
      expect(result.hookType).toBe('pass')
    })

    it('passes through simple unquoted commands', () => {
      const result = preBashHandler(makeBashEvent('ls -la /tmp'))
      // Should not have a quote hint (may compress or not)
      expect(result.hookType).not.toBe('context')
    })

    it('handles comment after command', () => {
      const result = preBashHandler(makeBashEvent('echo hello # comment with \'quotes\''))
      expect(result.hookType).toBe('pass')
    })

    it('detects unmatched quote before comment', () => {
      const result = preBashHandler(makeBashEvent('echo \'hello # comment'))
      expectHookType(result, 'context')
      expect(result.context).toContain('unclosed single quote')
    })

    it('handles real-world python -c example with nested quotes', () => {
      const cmd =
        'python3 -c "import sys; print(\\"hello world\\")"'
      const result = preBashHandler(makeBashEvent(cmd))
      // Same shape as the `node -e` sibling below: python is a recognised command so it compresses, but the quotes here are balanced and must draw no quote hint. This used to assert 'pass', which only held because the quoted `;` in the -c script wrongly disqualified the command from compression.
      // `not.toBe('context')` alone states the subject but still passes on a deny, so the exact outcome is pinned too: a regression that started denying this command would otherwise slip through a test whose whole point is that nothing is wrong with it.
      expect(result.hookType).not.toBe('context')
      expect(result.hookType).toBe('rewriteInput')
    })

    it('handles node -e with nested quotes', () => {
      const cmd = 'node -e "console.log(\'hello\')"'
      const result = preBashHandler(makeBashEvent(cmd))
      // node is a build command so may compress, but should not have quote hint
      expect(result.hookType).not.toBe('context')
    })

    it('detects unclosed quote in node -e command', () => {
      const cmd = 'node -e "console.log(\'hello'
      const result = preBashHandler(makeBashEvent(cmd))
      // Should have the quote hint
      expectHookType(result, 'context')
      expect(result.context).toContain('unclosed double quote')
    })

    it('passes through command with backticks when balanced', () => {
      const result = preBashHandler(makeBashEvent('echo `date`'))
      expect(result.hookType).toBe('pass')
    })

    it('passes through command with $(…) when balanced', () => {
      const result = preBashHandler(makeBashEvent('echo $(date)'))
      expect(result.hookType).toBe('pass')
    })

    it('handles heredoc with special characters in delimiter name', () => {
      const cmd = `cat <<MY_DELIMITER
content
MY_DELIMITER`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })

    it('handles heredoc with underscores', () => {
      const cmd = `cat <<_END_
data
_END_`
      const result = preBashHandler(makeBashEvent(cmd))
      expect(result.hookType).toBe('pass')
    })

    it('detects unterminated heredoc even with trailing content', () => {
      const cmd = `cat <<EOF
data
extra stuff here`
      const result = preBashHandler(makeBashEvent(cmd))
      expectHookType(result, 'context')
      expect(result.context).toContain('unterminated heredoc')
    })
  })

  describe('message quality', () => {
    it('includes the error description in the hint', () => {
      const result = preBashHandler(makeBashEvent("echo 'hello"))
      expectHookType(result, 'context')
      expect(result.context).toContain('unclosed single quote')
    })

    it('mentions Write tool as an alternative', () => {
      const result = preBashHandler(makeBashEvent('echo "hello'))
      expectHookType(result, 'context')
      expect(result.context).toContain('Write tool')
    })

    it('suggests using Write tool for multi-line strings with special characters', () => {
      const result = preBashHandler(makeBashEvent('echo "multi\nline\'string'))
      expectHookType(result, 'context')
      expect(result.context).toContain('multi-line string')
      expect(result.context).toContain('Write tool')
    })
  })
})

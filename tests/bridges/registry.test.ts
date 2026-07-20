import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectHarness, getHarnessName } from '../../src/bridges/registry.js'
import { clearModuleCaches } from '../../src/reset.js'

// Every env var any branch of detectHarness() reads, across both spellings
// codex/opencode ever used (CODEX_SESSION_ID vs CODEX_SESSION, OPENCODE_SESSION_ID
// vs OPENCODE_SESSION) plus the harness-override escape hatch.
const ENV_KEYS = [
  'TERM_PROGRAM',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_SESSION_ID',
  'ANTHROPIC_API_KEY',
  'CODEX_SESSION_ID',
  'CODEX_SESSION',
  'OPENCODE_SESSION_ID',
  'OPENCODE_SESSION',
  'GROK_SESSION_ID',
  'OPENCLAW_SESSION_ID',
  'HERMES_SESSION_ID',
  'HERMES_HOME',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'TOKEN_GOAT_HARNESS_OVERRIDE',
  'ANTHROPIC_BASE_URL',
  'OLLAMA_HOST',
  'OLLAMA_MODEL',
  'OLLAMA_KEEP_ALIVE',
] as const

describe('harness detection', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    clearModuleCaches()
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    clearModuleCaches()
  })

  describe('detectHarness', () => {
    it('returns claudecode when CLAUDE_CODE_VERSION is set', () => {
      process.env['CLAUDE_CODE_VERSION'] = '1.2.3'
      expect(detectHarness()).toBe('claudecode')
    })

    it('returns claudecode when TERM_PROGRAM is claude-code', () => {
      process.env['TERM_PROGRAM'] = 'claude-code'
      expect(detectHarness()).toBe('claudecode')
    })

    it('returns claudecode when CLAUDE_CODE_SESSION_ID is set', () => {
      process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-abc'
      expect(detectHarness()).toBe('claudecode')
    })

    it('returns claudecode when ANTHROPIC_API_KEY is set', () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
      expect(detectHarness()).toBe('claudecode')
    })

    it('returns codex when CODEX_SESSION_ID is set', () => {
      process.env['CODEX_SESSION_ID'] = 'abc'
      expect(detectHarness()).toBe('codex')
    })

    it('returns codex when CODEX_SESSION is set', () => {
      process.env['CODEX_SESSION'] = 'abc'
      expect(detectHarness()).toBe('codex')
    })

    it('returns opencode when OPENCODE_SESSION_ID is set', () => {
      process.env['OPENCODE_SESSION_ID'] = 'xyz'
      expect(detectHarness()).toBe('opencode')
    })

    it('returns opencode when OPENCODE_SESSION is set', () => {
      process.env['OPENCODE_SESSION'] = 'xyz'
      expect(detectHarness()).toBe('opencode')
    })

    it('returns openclaw when OPENCLAW_SESSION_ID is set', () => {
      process.env['OPENCLAW_SESSION_ID'] = 'oc-1'
      expect(detectHarness()).toBe('openclaw')
    })

    it('returns grok when GROK_SESSION_ID is set', () => {
      // Confirmed empirically (2026-07-09): grok 0.2.93 sets GROK_SESSION_ID
      // on every hook subprocess it spawns (see registry.ts for the live
      // capture this was verified against).
      process.env['GROK_SESSION_ID'] = 'g-1'
      expect(detectHarness()).toBe('grok')
    })

    it('returns hermes when HERMES_SESSION_ID is set', () => {
      process.env['HERMES_SESSION_ID'] = 'h-1'
      expect(detectHarness()).toBe('hermes')
    })

    it('returns hermes when HERMES_HOME is set', () => {
      process.env['HERMES_HOME'] = '/home/hermes'
      expect(detectHarness()).toBe('hermes')
    })

    it('returns codex when OPENAI_API_KEY is set without ANTHROPIC_API_KEY', () => {
      process.env['OPENAI_API_KEY'] = 'sk-openai-test'
      expect(detectHarness()).toBe('codex')
    })

    it('does not fall back to codex on OPENAI_API_KEY when ANTHROPIC_API_KEY is also set', () => {
      process.env['OPENAI_API_KEY'] = 'sk-openai-test'
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
      expect(detectHarness()).toBe('claudecode')
    })

    it('returns gemini when GEMINI_API_KEY is set without ANTHROPIC_API_KEY', () => {
      process.env['GEMINI_API_KEY'] = 'gk-test'
      expect(detectHarness()).toBe('gemini')
    })

    it('returns gemini when GOOGLE_API_KEY is set without ANTHROPIC_API_KEY', () => {
      process.env['GOOGLE_API_KEY'] = 'gk-test'
      expect(detectHarness()).toBe('gemini')
    })

    it('does not fall back to gemini on GEMINI_API_KEY when ANTHROPIC_API_KEY is also set', () => {
      process.env['GEMINI_API_KEY'] = 'gk-test'
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
      expect(detectHarness()).toBe('claudecode')
    })

    it('returns generic as fallback', () => {
      expect(detectHarness()).toBe('generic')
    })

    it('returns claudecode for an ollama launch claude session (ANTHROPIC_BASE_URL pointed at localhost:11434, no ANTHROPIC_API_KEY)', () => {
      process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-ollama'
      process.env['ANTHROPIC_BASE_URL'] = 'http://localhost:11434'
      expect(detectHarness()).toBe('claudecode')
    })

    it('ignores ambient OLLAMA_* env vars when detecting the harness', () => {
      process.env['OLLAMA_HOST'] = '127.0.0.1:11434'
      process.env['OLLAMA_MODEL'] = 'qwen2.5-coder:14b'
      process.env['OLLAMA_KEEP_ALIVE'] = '30m'
      expect(detectHarness()).toBe('generic')
    })

    it('prefers claudecode over codex when both signals are present', () => {
      process.env['CLAUDE_CODE_VERSION'] = '1.0'
      process.env['CODEX_SESSION_ID'] = 'abc'
      expect(detectHarness()).toBe('claudecode')
    })

    it('returns grok, not claudecode, when GROK_SESSION_ID and a bare ANTHROPIC_API_KEY are both set', () => {
      // Grok reuses Claude Code's own settings.json, so an ambient
      // ANTHROPIC_API_KEY is normal in a grok session; the bare-key claudecode
      // fallback must not preempt the GROK_SESSION_ID branch.
      process.env['GROK_SESSION_ID'] = 'g-1'
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
      expect(detectHarness()).toBe('grok')
    })

    it('returns codex, not claudecode, when CODEX_SESSION_ID and a bare ANTHROPIC_API_KEY are both set', () => {
      process.env['CODEX_SESSION_ID'] = 'abc'
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
      expect(detectHarness()).toBe('codex')
    })

    it('prefers hermes over claudecode when both signals are present', () => {
      process.env['HERMES_SESSION_ID'] = 'h-1'
      process.env['CLAUDE_CODE_VERSION'] = '1.0'
      expect(detectHarness()).toBe('hermes')
    })

    describe('TOKEN_GOAT_HARNESS_OVERRIDE', () => {
      it('takes priority over every other signal', () => {
        process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'opencode'
        process.env['CODEX_SESSION_ID'] = 'abc'
        process.env['CLAUDE_CODE_VERSION'] = '1.0'
        expect(detectHarness()).toBe('opencode')
      })

      it('is case-insensitive and trimmed', () => {
        process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = '  OpenClaw  '
        expect(detectHarness()).toBe('openclaw')
      })

      it('accepts every canonical harness name, including openclaw, pi, copilot_cli, grok, qwen, and hermes', () => {
        for (const name of ['claudecode', 'codex', 'opencode', 'gemini', 'hermes', 'openclaw', 'pi', 'copilot_cli', 'grok', 'qwen', 'generic']) {
          process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = name
          expect(detectHarness()).toBe(name)
        }
      })

      it('is the only way to resolve pi, since pi has no ambient env-var signal of its own', () => {
        process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'pi'
        expect(detectHarness()).toBe('pi')
      })

      it('is the only way to resolve copilot_cli, since Copilot CLI has no documented ambient env-var signal of its own', () => {
        process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'copilot_cli'
        expect(detectHarness()).toBe('copilot_cli')
      })

      it('falls through to normal detection when set to an unrecognized value', () => {
        process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'not-a-real-harness'
        process.env['CODEX_SESSION_ID'] = 'abc'
        expect(detectHarness()).toBe('codex')
      })
    })
  })

  describe('getHarnessName caching', () => {
    it('caches the first result across env changes', () => {
      process.env['CODEX_SESSION_ID'] = 'abc'
      expect(getHarnessName()).toBe('codex')
      delete process.env['CODEX_SESSION_ID']
      // Cached: still codex despite env now being empty.
      expect(getHarnessName()).toBe('codex')
    })

    it('cache is cleared by clearModuleCaches', () => {
      process.env['CODEX_SESSION_ID'] = 'abc'
      expect(getHarnessName()).toBe('codex')
      delete process.env['CODEX_SESSION_ID']
      clearModuleCaches()
      expect(getHarnessName()).toBe('generic')
    })
  })
})

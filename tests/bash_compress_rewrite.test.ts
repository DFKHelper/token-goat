/**
 * Phase 3 — wiring the bash-output compression framework into the pre_tool_use
 * hook. A recognized build/test command with no cached prior output is rewritten
 * to run through `token-goat compress`, so its output is structurally compressed
 * before it reaches the model.
 *
 * Two layers, per the project's injected-seam discipline:
 *   1. In-process unit tests of `preBashHandler` / `postBashHandler` /
 *      `serializeOutput` — the rewrite decision, field preservation, the cd
 *      prefix, the env + disabled-filter opt-outs, and the post-hook unwrap that
 *      keeps recall keyed on the original command.
 *   2. A built-bundle e2e that pipes a real `PreToolUse` payload through
 *      `dist/token-goat.mjs hook pre_tool_use` and asserts the exact wire JSON
 *      (`hookSpecificOutput.{hookEventName,permissionDecision,updatedInput}`).
 *      This is the authoritative coverage: a wrong wire shape silently disables
 *      the feature in production, which an in-process test cannot catch.
 *
 * The unit tests need a writable config to exercise the `disabled_filters`
 * branch, so `configPath()` is redirected (hoisted vi.mock) to a per-test temp
 * file — the same pattern tests/config.test.ts uses.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const _testConfigPath = path.join(os.tmpdir(), `tg-compress-rewrite-config-${process.pid}.toml`)
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import type { HookEvent } from '../src/hook_registry.js'
import { serializeOutput } from '../src/hook_registry.js'
import { preBashHandler, postBashHandler } from '../src/hooks_bash.js'
import { invalidateConfigCache } from '../src/config.js'
import { clearModuleCaches } from '../src/reset.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')

function preEvent(toolInput: Record<string, unknown>): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Bash',
    toolInput,
    sessionId: 's',
    raw: { tool_name: 'Bash', tool_input: toolInput },
  }
}

function postEvent(command: string, output: string): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 's',
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: output },
  }
}

const ORIG_BC = process.env['TOKEN_GOAT_BASH_COMPRESS']

beforeEach(() => {
  clearModuleCaches()
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // no config file → defaults (enabled, no disabled filters)
  }
  // Ensure compression is on by default for these tests, regardless of the
  // ambient shell (the dev may run the suite with the opt-out exported).
  delete process.env['TOKEN_GOAT_BASH_COMPRESS']
  invalidateConfigCache()
})

afterEach(() => {
  if (ORIG_BC === undefined) delete process.env['TOKEN_GOAT_BASH_COMPRESS']
  else process.env['TOKEN_GOAT_BASH_COMPRESS'] = ORIG_BC
  invalidateConfigCache()
})

afterAll(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // ignore
  }
})

describe('serializeOutput: rewriteInput', () => {
  it('emits the PreToolUse updatedInput wire shape', () => {
    const json = serializeOutput({
      hookType: 'rewriteInput',
      updatedInput: { command: 'token-goat compress -f generic -c \'cargo build\'', description: 'build' },
    })
    expect(JSON.parse(json)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          command: 'token-goat compress -f generic -c \'cargo build\'',
          description: 'build',
        },
      },
    })
  })
})

describe('preBashHandler: compression rewrite', () => {
  it('wraps a clean build command with no cached output', () => {
    const result = preBashHandler(preEvent({ command: 'cargo build' }))
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      expect(result.updatedInput['command']).toBe("token-goat compress -f cargo -c 'cargo build'")
    }
  })

  it('preserves every other tool_input field (description, timeout)', () => {
    const result = preBashHandler(
      preEvent({ command: 'go build ./...', description: 'compile', timeout: 120000 }),
    )
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      expect(result.updatedInput['description']).toBe('compile')
      expect(result.updatedInput['timeout']).toBe(120000)
      expect(result.updatedInput['command']).toBe("token-goat compress -f go -c 'go build ./...'")
    }
  })

  it('preserves a cd prefix inside the wrapped command so it runs in the right cwd', () => {
    const result = preBashHandler(preEvent({ command: 'cd /repo && cargo test' }))
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      // The compressor shell-runs the -c arg; the cd must survive so cargo runs in /repo.
      expect(result.updatedInput['command']).toBe(
        "token-goat compress -f cargo -c 'cd /repo && cargo test'",
      )
    }
  })

  it('does not wrap a piped command (only single commands are compressible)', () => {
    const result = preBashHandler(preEvent({ command: 'cargo build | tail -5' }))
    expect(result.hookType).toBe('pass')
  })

  it('does not wrap a non-build command', () => {
    const result = preBashHandler(preEvent({ command: 'echo hello' }))
    expect(result.hookType).toBe('pass')
  })

  it('respects TOKEN_GOAT_BASH_COMPRESS=0 (no rewrite)', () => {
    process.env['TOKEN_GOAT_BASH_COMPRESS'] = '0'
    invalidateConfigCache()
    const result = preBashHandler(preEvent({ command: 'cargo build' }))
    expect(result.hookType).toBe('pass')
  })

  it('respects a disabled filter in config (no rewrite)', () => {
    fs.writeFileSync(_testConfigPath, '[bash_compress]\ndisabled_filters = ["cargo"]\n')
    invalidateConfigCache()
    const result = preBashHandler(preEvent({ command: 'cargo build' }))
    expect(result.hookType).toBe('pass')
  })
})

describe('rewrite ↔ recall interaction', () => {
  it('post-hook unwraps the compress wrapper so recall keys on the original command', async () => {
    const original = 'cargo build'
    const wrapped = "token-goat compress -f generic -c 'cargo build'"
    // Simulate the harness running the *rewritten* command and the post-hook
    // seeing the wrapper with the compressed output.
    const compressedOutput = 'Compiling foo v0.1.0\n' + 'x'.repeat(800) + '\n'
    await postBashHandler(postEvent(wrapped, compressedOutput))

    // A later run of the ORIGINAL command must find the cached output and recall
    // it — proving the post-hook keyed on `cargo build`, not the wrapper.
    const result = preBashHandler(preEvent({ command: original }))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat bash-output')
    }
  })
})

describe('compression rewrite (built-bundle e2e)', () => {
  let tgHome: string

  beforeAll(() => {
    execFileSync(process.execPath, ['esbuild.config.mjs'], { cwd: ROOT, stdio: 'ignore' })
    tgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-compress-e2e-home-'))
  }, 120_000)

  afterAll(() => {
    try {
      fs.rmSync(tgHome, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  function runHook(payload: unknown): { stdout: string; status: number | null } {
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], {
      // Fresh isolated home → empty session store → no cache → the rewrite fires.
      env: { ...process.env, TOKEN_GOAT_HOME: tgHome, LOCALAPPDATA: tgHome, XDG_DATA_HOME: tgHome },
      input: JSON.stringify(payload),
      encoding: 'utf8',
    })
    return { stdout: res.stdout ?? '', status: res.status }
  }

  it('rewrites a build command to the compress wrapper with the correct wire shape', () => {
    // `go build ./...` is a recognized build command not cached by any other test
    // in this file, so the bundle's pre-hook produces a rewrite.
    const out = runHook({
      session_id: 'e2e-compress',
      tool_name: 'Bash',
      tool_input: { command: 'go build ./...' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: {
        hookEventName?: string
        permissionDecision?: string
        updatedInput?: { command?: string }
      }
    }
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('allow')
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f go -c 'go build ./...'",
    )
  })

  it('rewrites a registered test-runner command to its specific filter (batch A)', () => {
    // `npx vitest run` must select the registered `vitest` filter, not the
    // `generic` fallback — proving the batch-A registration survives esbuild
    // bundling and detectFromCommand prefers the specific filter.
    const out = runHook({
      session_id: 'e2e-compress-runner',
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: string } }
    }
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f vitest -c 'npx vitest run'",
    )
  })

  it('rewrites a wrapped pytest invocation to the bespoke pytest filter (batch A)', () => {
    // `python -m pytest tests/` must resolve through stripPrefixes to the
    // registered `pytest` filter — proving the batch-A-increment-2 bespoke
    // filter survives esbuild and that two-token launcher prefixes are handled.
    const out = runHook({
      session_id: 'e2e-compress-pytest',
      tool_name: 'Bash',
      tool_input: { command: 'python -m pytest tests/' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: string } }
    }
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f pytest -c 'python -m pytest tests/'",
    )
  })

  it('does not rewrite a non-build command (passes through)', () => {
    const out = runHook({
      session_id: 'e2e-compress',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    })
    expect(out.status).toBe(0)
    expect(out.stdout.trim()).toBe('{}')
  })

  it('rewrites pip install to the pip filter (batch B package-manager filter)', () => {
    // Verifies the batch-B package-manager filters survive esbuild: the pip
    // filter is registered in PACKAGE_MANAGER_FILTERS → spread into TOOL_FILTERS.
    const out = runHook({
      session_id: 'e2e-compress-pip',
      tool_name: 'Bash',
      tool_input: { command: 'pip install requests' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: string } }
    }
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f pip -c 'pip install requests'",
    )
  })

  it('rewrites eslint to the eslint filter (batch C linter filter)', () => {
    // Verifies the batch-C linter filters survive esbuild: the eslint filter is
    // registered in LINTER_FILTERS -> spread into TOOL_FILTERS.
    const out = runHook({
      session_id: 'e2e-compress-eslint',
      tool_name: 'Bash',
      tool_input: { command: 'eslint src/' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: string } }
    }
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f eslint -c 'eslint src/'",
    )
  })

  it('rewrites git diff to the git-diff filter (batch D vcs filter)', () => {
    // Verifies the batch-D vcs git filters survive esbuild: GitDiffFilter is
    // registered in GIT_FILTERS -> spread into TOOL_FILTERS.
    const out = runHook({
      session_id: 'e2e-compress-git-diff',
      tool_name: 'Bash',
      tool_input: { command: 'git diff HEAD' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: string } }
    }
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f git-diff -c 'git diff HEAD'",
    )
  })

  it('rewrites make to the make filter (batch E build-tool filter)', () => {
    // Verifies the batch-E build filters survive esbuild bundling: MakeFilter
    // is registered in BUILD_FILTERS -> spread into TOOL_FILTERS.
    const out = runHook({
      session_id: 'e2e-compress-make',
      tool_name: 'Bash',
      tool_input: { command: 'make all' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: string } }
    }
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f make -c 'make all'",
    )
  })

  it('rewrites cargo build to the cargo filter (batch E build-tool filter)', () => {
    // Verifies CargoFilter specifically survives esbuild and dispatch correctly
    // prefers -f cargo over -f generic for cargo subcommands.
    const out = runHook({
      session_id: 'e2e-compress-cargo',
      tool_name: 'Bash',
      tool_input: { command: 'cargo build --release' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: string } }
    }
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f cargo -c 'cargo build --release'",
    )
  })

  it('rewrites docker build to the docker filter (batch F container filter)', () => {
    // Verifies DockerFilter survives esbuild bundling and dispatch produces
    // the correct -f docker rewrite for the built bundle.
    const out = runHook({
      session_id: 'e2e-compress-docker',
      tool_name: 'Bash',
      tool_input: { command: 'docker build .' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: string } }
    }
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f docker -c 'docker build .'",
    )
  })

  it('rewrites terraform plan to the terraform filter (batch G cloud/IaC filter)', () => {
    // Verifies TerraformFilter survives esbuild bundling and dispatch produces
    // the correct -f terraform rewrite for the built bundle.
    const out = runHook({
      session_id: 'e2e-compress-terraform',
      tool_name: 'Bash',
      tool_input: { command: 'terraform plan' },
    })
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput?: { updatedInput?: { command?: string } }
    }
    expect(parsed.hookSpecificOutput?.updatedInput?.command).toBe(
      "token-goat compress -f terraform -c 'terraform plan'",
    )
  })

})

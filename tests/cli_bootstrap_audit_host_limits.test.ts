import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildBootstrapAudit, runBootstrapAudit } from '../src/cli_bootstrap_audit.js'
import { foldPath } from '../src/path_containment.js'
import { normalizePath } from '../src/paths.js'
import { MAX_OLD_FILE_BYTES_FOR_DIFF } from '../src/write_target.js'

// Every readFileSync the audit makes is recorded, and a path listed in refuseReads throws instead of being read, so a FIFO row proves the audit never reached for it without a real read that would hang the worker thread. The wrapper otherwise delegates.
const readPaths = vi.hoisted(() => [] as string[])
const refuseReads = vi.hoisted(() => new Set<string>())

function samePath(a: string, b: string): boolean {
  return foldPath(normalizePath(a)) === foldPath(normalizePath(b))
}

function wasRead(file: string): boolean {
  return readPaths.some((readPath) => samePath(readPath, file))
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const target = String(args[0])
      readPaths.push(target)
      if (refuseReads.has(target)) throw new Error(`the test refuses to read ${target}`)
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync,
  }
})

// Provenance. File sizes and line counts below are HAND-DERIVED from the bytes each test writes (every line is a known number of bytes plus its newline). The limits are FORMAT-DERIVED: Codex 32 KiB default and the cut-at-offset behaviour from https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs and codex-rs/config/src/config_toml.rs line 75 (read 2026-10-19), the combined-size wording from https://learn.chatgpt.com/docs/agent-configuration/agents-md; Claude Code 4 MiB skip, 200 lines or 25KB for MEMORY.md and the 200-line CLAUDE.md guideline from https://code.claude.com/docs/en/memory; Copilot's ~1,000-line guideline with no documented cut from https://docs.github.com/en/copilot/tutorials/use-custom-instructions.

interface Scratch {
  root: string
  project: string
  home: string
  codexHome: string
}

let scratch: Scratch

function lineBlock(count: number, bytesPerLine: number): string {
  return (('x'.repeat(bytesPerLine - 1)) + '\n').repeat(count)
}

function writeMemory(s: Scratch, content: string): void {
  const slug = path.resolve(s.project).replace(/[^A-Za-z0-9]/g, '-')
  const dir = path.join(s.home, '.claude', 'projects', slug, 'memory')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), content)
}

function findingFor(result: Awaited<ReturnType<typeof buildBootstrapAudit>>, kind: string, host: 'claude' | 'codex' | 'copilot') {
  const finding = result.host_limits.findings.find((f) => f.kind === kind && f.host === host)
  if (finding === undefined) throw new Error(`no finding for ${kind}`)
  return finding
}

async function runText(project: string, home: string): Promise<string> {
  const writes: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  try {
    await runBootstrapAudit({ project, home })
  } finally {
    write.mockRestore()
    process.exitCode = undefined
  }
  return writes.join('')
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-hostlimits-'))
  scratch = { root, project: path.join(root, 'project'), home: path.join(root, 'home'), codexHome: path.join(root, 'codexhome') }
  fs.mkdirSync(scratch.project, { recursive: true })
  fs.mkdirSync(scratch.home, { recursive: true })
  fs.mkdirSync(scratch.codexHome, { recursive: true })
  vi.stubEnv('CODEX_HOME', scratch.codexHome)
  readPaths.length = 0
  refuseReads.clear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(scratch.root, { recursive: true, force: true })
})

describe('bootstrap-audit host limits: Codex AGENTS.md', () => {
  it('loads an AGENTS.md under the default 32 KiB budget in full and says the budget is the default', async () => {
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(10, 100))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'AGENTS.md', 'codex')
    expect(finding.outcome).toBe('loaded')
    expect(finding.bytes).toBe(1000)
    expect(finding.not_loaded_bytes).toBe(0)
    expect(result.host_limits.codex).toMatchObject({ budget_bytes: 32768, budget_source: 'default', project_total_bytes: 1000 })
  })

  it('cuts an AGENTS.md over the default budget at byte 32768 and names the bytes not loaded', async () => {
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(400, 100))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'AGENTS.md', 'codex')
    expect(finding.outcome).toBe('cut')
    expect(finding.not_loaded_bytes).toBe(40000 - 32768)
    expect(finding.not_loaded_lines).toBe(400 - 328)
    expect(finding.verdict).toContain('cut at byte 32768 of 40000')
    expect(finding.limit).toContain('project_doc_max_bytes 32768 (default)')
    const text = await runText(scratch.project, scratch.home)
    expect(text).toContain('7232 bytes are not loaded')
  })

  it('reads project_doc_max_bytes from the Codex config and says it is configured', async () => {
    fs.writeFileSync(path.join(scratch.codexHome, 'config.toml'), 'project_doc_max_bytes = 300\n')
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(5, 100))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'AGENTS.md', 'codex')
    expect(result.host_limits.codex).toMatchObject({ budget_bytes: 300, budget_source: 'configured' })
    expect(finding.outcome).toBe('cut')
    expect(finding.not_loaded_bytes).toBe(200)
    expect(finding.limit).toContain('(configured)')
  })

  // FORMAT-DERIVED: a project's .codex/config.toml is a config layer above the user's, and project_doc_max_bytes is not in PROJECT_LOCAL_CONFIG_DENYLIST (codex-rs/config/src/loader/mod.rs at tag rust-v0.163.0, read 2026-10-19, installed codex-cli 0.163.0).
  function writeProjectCodexConfig(toml: string): string {
    const file = path.join(scratch.project, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, toml)
    return file
  }

  // FORMAT-DERIVED: project_doc_max_bytes is absent from PROJECT_LOCAL_CONFIG_DENYLIST (lines 89-102) and the repo layer `.codex/config.toml` is listed among the config layers (lines 125-135), https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/loader/mod.rs, read 2026-10-19; this proves agreement with that source, not with a shipped build.
  it('reads project_doc_max_bytes from the project .codex/config.toml and names that file', async () => {
    const projectConfig = writeProjectCodexConfig('project_doc_max_bytes = 300\n')
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(5, 100))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'AGENTS.md', 'codex')
    expect(result.host_limits.codex).toMatchObject({ budget_bytes: 300, budget_source: 'project config' })
    // The audit may spell the scratch path differently from os.tmpdir() (drive letter case, a Windows 8.3 RUNNER~1 name, macOS /private/var), so both sides go through the OS and are folded.
    expect(fs.realpathSync.native(result.host_limits.codex.config_path).toLowerCase()).toBe(fs.realpathSync.native(projectConfig).toLowerCase())
    expect(finding.outcome).toBe('cut')
    expect(finding.not_loaded_bytes).toBe(200)
    expect(finding.advice?.toLowerCase()).toContain(projectConfig.toLowerCase())
  })

  // FORMAT-DERIVED: the layer list in https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/loader/mod.rs (lines 125-135, read 2026-10-19) puts `user` before `repo`, and the file's comment at line 109 says layers are collected in ascending precedence order, so the project value wins and an unset project key falls through to the user's.
  it('lets the project value win over the user config, and falls back to the user value when the project sets none', async () => {
    fs.writeFileSync(path.join(scratch.codexHome, 'config.toml'), 'project_doc_max_bytes = 100000\n')
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(5, 100))
    writeProjectCodexConfig('project_doc_max_bytes = 200\n')
    const winning = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(winning.host_limits.codex).toMatchObject({ budget_bytes: 200, budget_source: 'project config' })
    writeProjectCodexConfig('model = "x"\n')
    const fallback = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(fallback.host_limits.codex).toMatchObject({ budget_bytes: 100000, budget_source: 'configured' })
    expect(findingFor(fallback, 'AGENTS.md', 'codex').outcome).toBe('loaded')
  })

  // FORMAT-DERIVED: project_doc_fallback_filenames is absent from PROJECT_LOCAL_CONFIG_DENYLIST (lines 89-102 of https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/loader/mod.rs, read 2026-10-19), so the project layer may set it; the file names in the row are HAND-DERIVED.
  it('takes project_doc_fallback_filenames from the project config too', async () => {
    writeProjectCodexConfig('project_doc_fallback_filenames = ["TEAM.md"]\n')
    fs.writeFileSync(path.join(scratch.project, 'TEAM.md'), lineBlock(3, 100))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(findingFor(result, 'TEAM.md', 'codex').outcome).toBe('loaded')
  })

  // FORMAT-DERIVED: Codex loads the project's .codex/config.toml layer but disables it for an untrusted project ("loaded but disabled when untrusted", codex-rs/config/src/loader/mod.rs at tag rust-v0.163.0, https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/loader/mod.rs lines 132-134, read 2026-10-19). The audit cannot tell trust, so a verdict resting on that layer says so.
  it('says a budget read from the project config applies only if Codex trusts the project, and a user-config budget does not', async () => {
    const trust = 'applies only if Codex trusts the project'
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(5, 100))
    writeProjectCodexConfig('project_doc_max_bytes = 300\n')
    const fromProject = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const cut = findingFor(fromProject, 'AGENTS.md', 'codex')
    expect(cut.limit).toContain(trust)
    expect(cut.verdict).toContain(trust)
    expect(await runText(scratch.project, scratch.home)).toContain(`(project config, ${trust})`)
    fs.rmSync(path.join(scratch.project, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(scratch.codexHome, 'config.toml'), 'project_doc_max_bytes = 300\n')
    const fromUser = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const userCut = findingFor(fromUser, 'AGENTS.md', 'codex')
    expect(userCut.limit).not.toContain('trusts')
    expect(userCut.verdict).not.toContain('trusts')
  })

  // FORMAT-DERIVED: same source as the row above (loader/mod.rs at rust-v0.163.0, "loaded but disabled when untrusted"); the advice names the project config as the file to edit, so it carries the same trust note as the verdict. Budgets 300 and 0 are HAND-DERIVED: 5 lines of 100 bytes overflow 300 (cut) and 0 leaves nothing (skipped).
  it.each([
    ['cut', 300],
    ['skipped', 0],
  ])('puts the project-config trust note in the %s advice, and none when the budget comes from the user config', async (outcome, budget) => {
    const trust = 'applies only if Codex trusts the project'
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(5, 100))
    writeProjectCodexConfig(`project_doc_max_bytes = ${budget}\n`)
    const fromProject = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'AGENTS.md', 'codex')
    expect(fromProject.outcome).toBe(outcome)
    expect(fromProject.advice).toContain(trust)
    fs.rmSync(path.join(scratch.project, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(scratch.codexHome, 'config.toml'), `project_doc_max_bytes = ${budget}\n`)
    const fromUser = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'AGENTS.md', 'codex')
    expect(fromUser.outcome).toBe(outcome)
    expect(fromUser.advice).not.toContain('trusts')
  })

  // HAND-DERIVED: TEAM.md is named only by the project config's fallback list and the budget comes from the user config, so the fallback note is the only project-config note the verdict can carry.
  it('says a doc found through the project config fallback list came from the project config, with the budget from the user config', async () => {
    fs.writeFileSync(path.join(scratch.codexHome, 'config.toml'), 'project_doc_max_bytes = 300\n')
    writeProjectCodexConfig('project_doc_fallback_filenames = ["TEAM.md"]\n')
    fs.writeFileSync(path.join(scratch.project, 'TEAM.md'), lineBlock(2, 100))
    const finding = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'TEAM.md', 'codex')
    expect(finding.outcome).toBe('loaded')
    expect(finding.verdict).toContain('found through project_doc_fallback_filenames in the project config')
    expect(finding.verdict).toContain('applies only if Codex trusts the project')
  })

  // HAND-DERIVED: five 100-byte lines overflow the 300-byte user budget, so the cut verdict and its advice both carry the fallback note.
  it('puts the fallback note in the verdict and the advice of a cut doc found through the project config fallback list', async () => {
    fs.writeFileSync(path.join(scratch.codexHome, 'config.toml'), 'project_doc_max_bytes = 300\n')
    writeProjectCodexConfig('project_doc_fallback_filenames = ["TEAM.md"]\n')
    fs.writeFileSync(path.join(scratch.project, 'TEAM.md'), lineBlock(5, 100))
    const finding = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'TEAM.md', 'codex')
    expect(finding.outcome).toBe('cut')
    expect(finding.verdict).toContain('found through project_doc_fallback_filenames in the project config')
    expect(finding.verdict).toContain('applies only if Codex trusts the project')
    expect(finding.advice).toContain('project_doc_fallback_filenames in the project config')
    expect(finding.advice).toContain('applies only if Codex trusts the project')
  })

  // HAND-DERIVED: TEAM.md appears only in the user config's fallback list, so the project layer did not choose it and neither verdict may carry a project-config note.
  it('adds no project-config note to a doc named only in the user config fallback list', async () => {
    fs.writeFileSync(path.join(scratch.codexHome, 'config.toml'), 'project_doc_max_bytes = 300\nproject_doc_fallback_filenames = ["TEAM.md"]\n')
    fs.writeFileSync(path.join(scratch.project, 'TEAM.md'), lineBlock(2, 100))
    const finding = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'TEAM.md', 'codex')
    expect(finding.outcome).toBe('loaded')
    expect(finding.verdict).not.toContain('project_doc_fallback_filenames')
    expect(finding.verdict).not.toContain('trusts')
  })

  // HAND-DERIVED: AGENTS.md is the default name, found before any fallback name, and it is also listed as a project fallback name so the default-name exclusion in fallbackFromProject is the only thing keeping the note off it.
  it('adds no project-config note to the default AGENTS.md when the project config has a fallback list', async () => {
    writeProjectCodexConfig('project_doc_fallback_filenames = ["AGENTS.md", "TEAM.md"]\n')
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(2, 100))
    const finding = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'AGENTS.md', 'codex')
    expect(finding.outcome).toBe('loaded')
    expect(finding.verdict).not.toContain('trusts')
  })

  // HAND-DERIVED: AGENTS.override.md is the local name, found before any fallback name, and it is also listed as a project fallback name so the local-name exclusion in fallbackFromProject is the only thing keeping the note off it.
  it('adds no project-config note to the local AGENTS.override.md when the project config has a fallback list', async () => {
    writeProjectCodexConfig('project_doc_fallback_filenames = ["AGENTS.override.md", "TEAM.md"]\n')
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.override.md'), lineBlock(2, 100))
    const finding = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'AGENTS.override.md', 'codex')
    expect(finding.outcome).toBe('loaded')
    expect(finding.verdict).not.toContain('trusts')
  })

  it('skips an AGENTS.md when the configured budget is zero', async () => {
    fs.writeFileSync(path.join(scratch.codexHome, 'config.toml'), 'project_doc_max_bytes = 0\n')
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(2, 100))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'AGENTS.md', 'codex')
    expect(finding.outcome).toBe('skipped')
    expect(finding.not_loaded_bytes).toBe(200)
  })

  it('does not count the user-level AGENTS.md against the project budget', async () => {
    fs.writeFileSync(path.join(scratch.codexHome, 'AGENTS.md'), lineBlock(500, 100))
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(10, 100))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(findingFor(result, 'AGENTS.md', 'codex').outcome).toBe('loaded')
    expect(findingFor(result, 'global AGENTS.md', 'codex').limit).toContain('not counted against project_doc_max_bytes')
  })
})

describe('bootstrap-audit host limits: the Codex config read is bounded', () => {
  // HAND-DERIVED: the rule is "a config path the project controls is read only if it is a regular file, within the cap the Write hook already holds, and inside the project"; the rows build each violating shape directly. The 300-byte budget in a refused file is a value the default (32768) cannot produce, so reading it would show.
  const BUDGET_300 = 'project_doc_max_bytes = 300\n'
  const projectConfigPath = (): string => path.join(scratch.project, '.codex', 'config.toml')
  const userConfigPath = (): string => path.join(scratch.codexHome, 'config.toml')
  const reasonFor = (result: Awaited<ReturnType<typeof buildBootstrapAudit>>, file: string): string | undefined =>
    result.host_limits.diagnostics.find((d) => samePath(d.path, file))?.reason

  const canSymlink = ((): boolean => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-hostlimits-link-'))
    try {
      fs.writeFileSync(path.join(probe, 'target'), '')
      fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'))
      return true
    } catch {
      return false
    } finally {
      fs.rmSync(probe, { recursive: true, force: true })
    }
  })()

  // HAND-DERIVED: mkfifo makes a named pipe; reading one waits for a writer, so a read of it never returns. POSIX only: Windows has no FIFO.
  it.skipIf(process.platform === 'win32')('never reads a project .codex/config.toml that is a FIFO', async () => {
    const file = projectConfigPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const made = spawnSync('mkfifo', [file], { encoding: 'utf8' })
    expect(made.status, made.stderr).toBe(0)
    refuseReads.add(file)
    refuseReads.add(normalizePath(file))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(wasRead(file), 'the FIFO path was read through another spelling').toBe(false)
    expect(reasonFor(result, file)).toContain('not a regular file')
    expect(result.host_limits.codex.budget_source).toBe('default')
  })

  // HAND-DERIVED: a directory is the one non-regular file every platform can create.
  it('refuses a directory at the project config path and a directory at the user config path', async () => {
    fs.mkdirSync(projectConfigPath(), { recursive: true })
    fs.mkdirSync(userConfigPath(), { recursive: true })
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(wasRead(projectConfigPath()), 'the project directory was read through another spelling').toBe(false)
    expect(wasRead(userConfigPath()), 'the user directory was read through another spelling').toBe(false)
    expect(reasonFor(result, projectConfigPath())).toContain('not a regular file')
    expect(reasonFor(result, userConfigPath())).toContain('not a regular file')
    expect(result.host_limits.codex).toMatchObject({ budget_bytes: 32768, budget_source: 'default' })
  })

  // HAND-DERIVED: MAX_OLD_FILE_BYTES_FOR_DIFF is the cap the Write hook holds; a file one byte over it is refused, one exactly at it is read. The budget line leads the file so a read of the oversized one would show.
  function configOfSize(file: string, bytes: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, BUDGET_300 + '#'.repeat(bytes - BUDGET_300.length))
  }

  it('refuses a project config and a user config one byte over the cap, and reads one exactly at it', async () => {
    configOfSize(projectConfigPath(), MAX_OLD_FILE_BYTES_FOR_DIFF + 1)
    const refusedProject = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(reasonFor(refusedProject, projectConfigPath())).toContain('is over')
    expect(refusedProject.host_limits.codex).toMatchObject({ budget_bytes: 32768, budget_source: 'default' })
    fs.rmSync(path.dirname(projectConfigPath()), { recursive: true })
    configOfSize(userConfigPath(), MAX_OLD_FILE_BYTES_FOR_DIFF + 1)
    const refusedUser = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(reasonFor(refusedUser, userConfigPath())).toContain('is over')
    expect(refusedUser.host_limits.codex.budget_source).toBe('default')
    configOfSize(userConfigPath(), MAX_OLD_FILE_BYTES_FOR_DIFF)
    const atCap = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(atCap.host_limits.codex).toMatchObject({ budget_bytes: 300, budget_source: 'configured' })
  })

  // HAND-DERIVED: a link whose target lies outside the project root is the repository naming a file it does not own; a link whose target is inside the root is ordinary. Skipped where the OS refuses to make a symlink.
  it.skipIf(!canSymlink)('does not follow a project config link out of the project, and follows one that stays inside', async () => {
    const outside = path.join(scratch.root, 'outside.toml')
    fs.writeFileSync(outside, BUDGET_300)
    fs.mkdirSync(path.dirname(projectConfigPath()), { recursive: true })
    fs.symlinkSync(outside, projectConfigPath())
    const refused = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(wasRead(projectConfigPath()), 'the outside symlink was read through another spelling').toBe(false)
    expect(reasonFor(refused, projectConfigPath())).toContain('leads outside the project')
    expect(refused.host_limits.codex).toMatchObject({ budget_bytes: 32768, budget_source: 'default' })
    fs.unlinkSync(projectConfigPath())
    const inside = path.join(scratch.project, 'shared.toml')
    fs.writeFileSync(inside, BUDGET_300)
    fs.symlinkSync(inside, projectConfigPath())
    const followed = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(followed.host_limits.codex).toMatchObject({ budget_bytes: 300, budget_source: 'project config' })
  })
})

describe('bootstrap-audit host limits: Claude Code', () => {
  it('skips a CLAUDE.md over 4 MiB entirely and never says truncated', async () => {
    fs.writeFileSync(path.join(scratch.project, 'CLAUDE.md'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x61))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'CLAUDE.md', 'claude')
    expect(finding.outcome).toBe('skipped')
    expect(finding.not_loaded_bytes).toBe(4 * 1024 * 1024 + 1)
    const text = await runText(scratch.project, scratch.home)
    expect(text).toContain('skipped')
    expect(text.toLowerCase()).not.toContain('truncat')
  })

  it('loads a CLAUDE.md of exactly 4 MiB in full', async () => {
    fs.writeFileSync(path.join(scratch.project, 'CLAUDE.md'), Buffer.alloc(4 * 1024 * 1024, 0x61))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(findingFor(result, 'CLAUDE.md', 'claude').outcome).toBe('loaded')
  })

  it('words the 200-line CLAUDE.md figure as a guideline and keeps the file loaded', async () => {
    fs.writeFileSync(path.join(scratch.project, 'CLAUDE.md'), lineBlock(250, 10))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'CLAUDE.md', 'claude')
    expect(finding.outcome).toBe('loaded')
    expect(finding.verdict).toContain('guideline, not a limit')
    expect(finding.not_loaded_bytes).toBe(0)
  })

  it('counts the lines not loaded from a MEMORY.md over 200 lines', async () => {
    writeMemory(scratch, lineBlock(250, 2))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'MEMORY.md', 'claude')
    expect(finding.outcome).toBe('cut')
    expect(finding.not_loaded_lines).toBe(50)
    expect(finding.not_loaded_bytes).toBe(100)
  })

  it('loads a MEMORY.md of exactly 200 lines in full', async () => {
    writeMemory(scratch, lineBlock(200, 2))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(findingFor(result, 'MEMORY.md', 'claude')).toMatchObject({ outcome: 'loaded', not_loaded_lines: 0, not_loaded_bytes: 0 })
  })

  it('counts the bytes and lines not loaded from a MEMORY.md over 25 KB', async () => {
    // 100 lines of 300 bytes: the first 25000 bytes hold 83 whole lines (24900) and 100 bytes of line 84.
    writeMemory(scratch, lineBlock(100, 300))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'MEMORY.md', 'claude')
    expect(finding.outcome).toBe('cut')
    expect(finding.not_loaded_bytes).toBe(5000)
    expect(finding.not_loaded_lines).toBe(16)
  })
})

describe('bootstrap-audit host limits: MEMORY.md at the 25KB boundary', () => {
  // HAND-DERIVED: the docs write "25KB" without saying 1000 or 1024 bytes, so 25000 is the last size loaded under both readings, 25601 the first cut under both, and the sizes between are cut under one reading only. Each file is 100 lines, so the 200-line cap never applies; line 1 carries the remainder.
  function memoryOfSize(bytes: number): string {
    const perLine = Math.floor(bytes / 100)
    const extra = bytes - perLine * 100
    return 'x'.repeat(perLine - 1 + extra) + '\n' + lineBlock(99, perLine)
  }

  it('loads a MEMORY.md of exactly 25000 bytes in full', async () => {
    writeMemory(scratch, memoryOfSize(25000))
    const finding = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'MEMORY.md', 'claude')
    expect(finding).toMatchObject({ bytes: 25000, outcome: 'loaded', not_loaded_bytes: 0 })
  })

  it.each([25001, 25600])('calls a MEMORY.md of %i bytes uncertain, never a firm cut, and names the KB/KiB ambiguity', async (size) => {
    writeMemory(scratch, memoryOfSize(size))
    const finding = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'MEMORY.md', 'claude')
    expect(finding.bytes).toBe(size)
    expect(finding.outcome).toBe('uncertain')
    expect(finding.verdict).toContain('uncertain')
    expect(finding.verdict).toContain('KiB')
    expect(finding.verdict).not.toMatch(/^cut/)
    expect(finding.not_loaded_bytes).toBe(0)
  })

  it('cuts a MEMORY.md of 25601 bytes, which both readings cut', async () => {
    writeMemory(scratch, memoryOfSize(25601))
    const finding = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'MEMORY.md', 'claude')
    expect(finding).toMatchObject({ bytes: 25601, outcome: 'cut', not_loaded_bytes: 601 })
    expect(finding.verdict).toMatch(/^cut/)
  })

  it('still cuts a 25099-byte MEMORY.md of 301 lines at the 200-line cap, firm under both readings', async () => {
    writeMemory(scratch, lineBlock(300, 83) + 'x'.repeat(199))
    const finding = findingFor(await buildBootstrapAudit({ project: scratch.project, home: scratch.home }), 'MEMORY.md', 'claude')
    expect(finding.bytes).toBe(25099)
    expect(finding.outcome).toBe('cut')
  })
})

describe('bootstrap-audit host limits: Copilot and unsourced hosts', () => {
  it('reports a Copilot file over 1,000 lines as a guideline, never as a cut', async () => {
    fs.mkdirSync(path.join(scratch.project, '.github'), { recursive: true })
    fs.writeFileSync(path.join(scratch.project, '.github', 'copilot-instructions.md'), lineBlock(1001, 10))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, 'copilot-instructions.md', 'copilot')
    expect(finding.outcome).toBe('loaded')
    expect(finding.not_loaded_bytes).toBe(0)
    expect(finding.limit).toBe('no truncation limit documented')
    expect(finding.verdict).toContain('a quality guideline, not a limit')
    const text = await runText(scratch.project, scratch.home)
    expect(text).toContain('quality may deteriorate; nothing is documented as cut')
    expect(text).not.toMatch(/truncated|skipped|are not loaded/i)
  })

  it('does not warn about a Copilot file of exactly 1,000 lines and finds *.instructions.md files', async () => {
    fs.mkdirSync(path.join(scratch.project, '.github', 'instructions'), { recursive: true })
    fs.writeFileSync(path.join(scratch.project, '.github', 'instructions', 'ts.instructions.md'), lineBlock(1000, 10))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const finding = findingFor(result, '*.instructions.md', 'copilot')
    expect(finding.advice).toBeNull()
  })

  // FORMAT-DERIVED: an absence claim. The GitHub Docs page on personal instructions (https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-personal-instructions, fetched 2026-10-19) says "Use any format" and names no size cap, which is why the Copilot user-level row is printed as unknown; the VS Code Chat and cloud agent rows are UNVERIFIED this run (their pages were not read), and a later doc that names a cap makes these rows stale.
  it('prints unknown for the hosts whose limits were not sourced', async () => {
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    expect(result.host_limits.unknown.map((u) => u.host)).toEqual(['VS Code Chat', 'Copilot cloud agent', 'Copilot'])
    expect(result.host_limits.unknown.every((u) => u.limit === 'unknown')).toBe(true)
    const text = await runText(scratch.project, scratch.home)
    expect(text).toContain('[VS Code Chat] instruction file size cap: unknown')
    expect(text).toContain('[Copilot cloud agent] instruction file size cap: unknown')
    expect(text).toContain('[Copilot] user-level instructions size cap: unknown')
  })
})

describe('bootstrap-audit host limits: ordering', () => {
  it('puts the file that loses the most first, then the rest by estimated tokens', async () => {
    // Codex AGENTS.md loses 7232 bytes; MEMORY.md loses 100; the 100000-byte CLAUDE.md loses nothing but costs most.
    fs.writeFileSync(path.join(scratch.project, 'AGENTS.md'), lineBlock(400, 100))
    fs.writeFileSync(path.join(scratch.project, 'CLAUDE.md'), lineBlock(1000, 100))
    writeMemory(scratch, lineBlock(250, 2))
    const result = await buildBootstrapAudit({ project: scratch.project, home: scratch.home })
    const kinds = result.host_limits.findings.map((f) => f.kind)
    expect(kinds.slice(0, 3)).toEqual(['AGENTS.md', 'MEMORY.md', 'CLAUDE.md'])
    const text = await runText(scratch.project, scratch.home)
    const advice = text.slice(text.indexOf('Advice, biggest loss or cost first:'))
    expect(advice.indexOf('AGENTS.md')).toBeLessThan(advice.indexOf('MEMORY.md'))
    expect(advice.indexOf('MEMORY.md')).toBeLessThan(advice.indexOf('CLAUDE.md'))
  })
})

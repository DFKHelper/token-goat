// Regression: token-goat hardcoded `~/.claude` at a dozen sites while Claude Code resolves its
// entire config home through `CLAUDE_CONFIG_DIR`, falling back to `~/.claude`. For any user who
// exports that variable, the installer WROTE the hooks shim, the settings.json wiring, the
// CLAUDE.md block and the skill into a tree Claude Code never reads, and the skill cache, agent
// roster, transcript corpus and CLAUDE.md/MEMORY.md walks all READ from that same dead tree -- a
// silent no-op install with no error anywhere.
//
// FIXTURE PROVENANCE: FORMAT-DERIVED from the shipping Claude Code binary at
// C:/Users/zelys/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe
// (235,169,440 bytes). Its config-home accessor reads
// `var ve=Qo(()=>(s()??a(R(),".claude")).normalize("NFC"),s)` with
// `function s(){return process.env.CLAUDE_CONFIG_DIR}` -- i.e. `CLAUDE_CONFIG_DIR ?? join(homedir(),
// '.claude')` -- and every config path hangs off `ve()`: skills (11 call sites), CLAUDE.md (4),
// plugins (4), projects (2), settings.json (1), with ZERO resolving from a bare home directory.
// The agent-definition frontmatter shape below is reused verbatim from tests/hooks_agent_spawn.test.ts.
//
// Every case is paired with a calibration case asserting the `~/.claude` fallback still wins while
// the variable is unset: without that pairing, a test that trivially passes is indistinguishable
// from one that works.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { claudeConfigDir } from '../src/claude_config_dir.js'
import { buildBootstrapAudit } from '../src/cli_bootstrap_audit.js'
import { findClaudeMdFiles, findMemoryMd } from '../src/cli_context_stats.js'
import { findRestrictedAgentNames } from '../src/hooks_agent_spawn.js'
import { claudeHookScriptPath, claudeMdPath, findStrayClaudeMdBlocks, settingsPath, skillDir } from '../src/install.js'
import { defaultCorpusDir } from '../src/session_audit.js'
import { installedSkillPath } from '../src/skill_cache.js'
import { projectTranscriptsDir } from '../src/waste.js'

let configHome: string
let prev: string | undefined

beforeEach(() => {
  prev = process.env['CLAUDE_CONFIG_DIR']
  configHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-claude-config-')))
})

afterEach(() => {
  if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = prev
  fs.rmSync(configHome, { recursive: true, force: true })
})

function withVar<T>(fn: () => T): T {
  process.env['CLAUDE_CONFIG_DIR'] = configHome
  try {
    return fn()
  } finally {
    delete process.env['CLAUDE_CONFIG_DIR']
  }
}

describe('claudeConfigDir', () => {
  it('returns CLAUDE_CONFIG_DIR when it is set to a non-empty value', () => {
    expect(withVar(() => claudeConfigDir())).toBe(configHome)
  })

  it('falls back to <home>/.claude when the variable is unset (calibration)', () => {
    delete process.env['CLAUDE_CONFIG_DIR']
    expect(claudeConfigDir()).toBe(path.join(os.homedir(), '.claude'))
  })

  it('falls back to <homeDir arg>/.claude, preserving the injectable home seam (calibration)', () => {
    delete process.env['CLAUDE_CONFIG_DIR']
    expect(claudeConfigDir('/injected/home')).toBe(path.join('/injected/home', '.claude'))
  })

  it('lets the variable outrank an injected homeDir, exactly as it outranks homedir() inside Claude Code', () => {
    expect(withVar(() => claudeConfigDir('/injected/home'))).toBe(configHome)
  })

  it('treats an empty variable as unset rather than as the process cwd (calibration)', () => {
    process.env['CLAUDE_CONFIG_DIR'] = ''
    expect(claudeConfigDir('/injected/home')).toBe(path.join('/injected/home', '.claude'))
  })
})

describe('installer write targets follow CLAUDE_CONFIG_DIR', () => {
  it('puts the hook shim, user settings.json, CLAUDE.md block and skill under the configured home', () => {
    const paths = withVar(() => ({
      shim: claudeHookScriptPath(),
      settings: settingsPath('user'),
      claudeMd: claudeMdPath(),
      skill: skillDir(),
    }))
    expect(paths.shim).toBe(path.join(configHome, 'hooks', 'token-goat-shim.js'))
    expect(paths.settings).toBe(path.join(configHome, 'settings.json'))
    expect(paths.claudeMd).toBe(path.join(configHome, 'CLAUDE.md'))
    expect(paths.skill).toBe(path.join(configHome, 'skills', 'token-goat'))
  })

  it('keeps every one of those under <home>/.claude when the variable is unset (calibration)', () => {
    delete process.env['CLAUDE_CONFIG_DIR']
    const base = path.join(os.homedir(), '.claude')
    expect(claudeHookScriptPath()).toBe(path.join(base, 'hooks', 'token-goat-shim.js'))
    expect(settingsPath('user')).toBe(path.join(base, 'settings.json'))
    expect(claudeMdPath()).toBe(path.join(base, 'CLAUDE.md'))
    expect(skillDir()).toBe(path.join(base, 'skills', 'token-goat'))
  })

  it('leaves project scope resolving against the cwd, which Claude Code resolves independently of the config home', () => {
    const expected = path.join(process.cwd(), '.claude', 'settings.json')
    expect(withVar(() => settingsPath('project'))).toBe(expected)
  })

  it('scans the configured home for stray CLAUDE.md blocks, and still honours an explicit searchRoot', () => {
    fs.mkdirSync(path.join(configHome, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(configHome, 'nested', 'CLAUDE.md'), '<!-- token-goat-begin -->\nx\n<!-- token-goat-end -->\n')
    const found = withVar(() => findStrayClaudeMdBlocks())
    expect(found).toContain(path.join(configHome, 'nested', 'CLAUDE.md'))
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stray-root-'))
    try {
      expect(withVar(() => findStrayClaudeMdBlocks(other))).toEqual([])
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('read paths follow CLAUDE_CONFIG_DIR', () => {
  it('resolves an installed skill out of the configured skills directory', async () => {
    const dir = path.join(configHome, 'skills', 'demo-skill')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo-skill\n---\nbody\n')
    process.env['CLAUDE_CONFIG_DIR'] = configHome
    const hit = await installedSkillPath('demo-skill')
    delete process.env['CLAUDE_CONFIG_DIR']
    expect(hit).toBe(path.resolve(dir, 'SKILL.md'))
    // Calibration: the same skill is invisible once the variable is gone, so the hit above came from the configured tree and not from the machine's real one.
    await expect(installedSkillPath('demo-skill')).resolves.toBeNull()
  })

  it('reads the agent roster from the configured agents directory', () => {
    const dir = path.join(configHome, 'agents')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'locked.md'), '---\nname: config-dir-restricted-agent\ntools: Read\n---\nb')
    expect(withVar(() => findRestrictedAgentNames())).toContain('config-dir-restricted-agent')
    // Calibration: unset, the sandboxed home holds no such roster.
    expect(findRestrictedAgentNames()).not.toContain('config-dir-restricted-agent')
  })

  it('points the transcript corpus and this project transcript directory at the configured projects tree', () => {
    const slug = path.resolve(process.cwd()).replace(/[^A-Za-z0-9]/g, '-')
    fs.mkdirSync(path.join(configHome, 'projects', slug), { recursive: true })
    fs.writeFileSync(path.join(configHome, 'projects', slug, 'a.jsonl'), '{}\n')
    const seen = withVar(() => ({ corpus: defaultCorpusDir(), transcripts: projectTranscriptsDir(process.cwd()) }))
    expect(seen.corpus).toBe(path.join(configHome, 'projects'))
    expect(seen.transcripts).toBe(path.join(configHome, 'projects', slug))
    // Calibration: unset, both fall back to the home tree.
    expect(projectTranscriptsDir(process.cwd())).toBe(path.join(os.homedir(), '.claude', 'projects', slug))
  })

  it('finds the global CLAUDE.md and MEMORY.md under the configured home, and still honours the homeDir seam when unset', () => {
    const slug = path.resolve(process.cwd()).replace(/[^A-Za-z0-9]/g, '-')
    fs.writeFileSync(path.join(configHome, 'CLAUDE.md'), '# global\n')
    fs.mkdirSync(path.join(configHome, 'projects', slug, 'memory'), { recursive: true })
    fs.writeFileSync(path.join(configHome, 'projects', slug, 'memory', 'MEMORY.md'), '# mem\n')
    const seen = withVar(() => ({
      claudeMd: findClaudeMdFiles(process.cwd(), '/nonexistent-home'),
      memory: findMemoryMd(process.cwd(), '/nonexistent-home'),
    }))
    expect(seen.claudeMd).toContain(path.join(configHome, 'CLAUDE.md'))
    expect(seen.memory).toBe(path.join(configHome, 'projects', slug, 'memory', 'MEMORY.md'))
    // Calibration: with the variable unset the injected homeDir is what is joined with `.claude`, so the seam still works and nothing is read from the configured tree.
    expect(findClaudeMdFiles(process.cwd(), configHome)).not.toContain(path.join(configHome, 'CLAUDE.md'))
    expect(findMemoryMd(process.cwd(), path.dirname(configHome))).toBeNull()
  })

  it('audits the agents and skills the configured home installs', async () => {
    fs.mkdirSync(path.join(configHome, 'skills', 'audited-skill'), { recursive: true })
    fs.writeFileSync(path.join(configHome, 'skills', 'audited-skill', 'SKILL.md'), '---\nname: audited-skill\ndescription: d\n---\nbody\n')
    process.env['CLAUDE_CONFIG_DIR'] = configHome
    const withConfig = await buildBootstrapAudit({ home: '/nonexistent-home' })
    delete process.env['CLAUDE_CONFIG_DIR']
    expect(withConfig.counts.skills).toBe(1)
    expect(withConfig.largest.map((e) => e.path)).toContain(path.join(configHome, 'skills', 'audited-skill', 'SKILL.md'))
    // Calibration: unset, the same audit against a home that has no `.claude` tree finds nothing.
    const withoutConfig = await buildBootstrapAudit({ home: path.dirname(configHome) })
    expect(withoutConfig.counts.skills).toBe(0)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Config } from '../src/config.js'
import { checkEmbeddingModel, runDoctorAndExit, runDoctorRepair } from '../src/cli_doctor.js'
import * as embedModel from '../src/embed_model.js'
import * as configModule from '../src/config.js'
import { recordCreatedConfig } from '../src/bridges/created_configs.js'
import { _resetDataDirCacheForTesting, configPath } from '../src/constants.js'
import { downloadAdvice } from '../src/embed_preflight.js'
import { MODEL_DOWNLOAD_HOST, clearDownloadFailure, isExplicitDownload, recordDownloadFailure } from '../src/model_download_gate.js'
import { INSTRUCTION_GATE_BEGIN, INSTRUCTION_GATE_END } from '../src/cli_doctor_guidance.js'
import { DEV_CHECKOUT_ADVICE } from '../src/cli_upgrade.js'
import { clearUpdateCheck, seedUpdateCheck } from './helpers/update-check.js'
import { allowWrites, denyWrites } from './helpers/seal-directory.js'
import { CliError, formatCommandError } from '../src/command_error.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { copilotCliConfigPath, copilotCliHooksDir, copilotCliInstructionsPath, copilotCliScriptPath, installCopilotHooksFile, wiredCopilotHookWords, writeCopilotInstructionsBlock } from '../src/bridges/copilot_cli_install.js'
import { copilotMcpConfigPath } from '../src/bridges/copilot_mcp_install.js'

describe('doctor auto-repair and embedding model checks', () => {
  // runDoctorRepair checks the instruction gate against the user-level files and the project root, and writes the project when no gate is active anywhere. Every call gets a scratch project and a scratch home holding the gate `token-goat install` writes to ~/.claude/CLAUDE.md, so a healthy install reads as healthy and nothing touches the real home or the checkout the suite runs from.
  let userHome: string
  let projectRoot: string

  beforeEach(() => {
    delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
    vi.restoreAllMocks()
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-repair-home-'))
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-repair-root-'))
    vi.stubEnv('HOME', userHome)
    vi.stubEnv('USERPROFILE', userHome)
    // The suite pins embeddings off through the environment; the repair's job here is the config layer, and an env-held switch is exercised by its own test.
    vi.stubEnv('TOKEN_GOAT_EMBEDDINGS_ENABLED', undefined)
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(userHome, '.claude'))
    vi.stubEnv('COPILOT_HOME', path.join(userHome, '.copilot'))
    fs.mkdirSync(path.join(userHome, '.claude'))
    fs.writeFileSync(path.join(userHome, '.claude', 'CLAUDE.md'), `${INSTRUCTION_GATE_BEGIN}\nGate body\n${INSTRUCTION_GATE_END}\n`)
    // Step 7 reads the update check from the cache, so no test asks a registry and none changes its result the day npm serves a newer version.
    seedUpdateCheck()
  })

  afterEach(() => {
    clearUpdateCheck()
    vi.unstubAllEnvs()
    fs.rmSync(userHome, { recursive: true, force: true })
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  describe('checkEmbeddingModel', () => {
    it('returns ok when embeddings are disabled by config', () => {
      const config = { indexing: { embeddings_enabled: false } } as unknown as Config
      const result = checkEmbeddingModel(config)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('disabled by config')
    })

    it('returns warn and advises repair when model files are missing and offline mode is on', () => {
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      const config = {
        indexing: { embeddings_enabled: true },
        network: { offline: true },
      } as unknown as Config
      const result = checkEmbeddingModel(config)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('network.offline = true')
      expect(result.message).toContain('token-goat doctor --repair')
    })

    it('returns warn and advises repair when model files are missing and network is online', () => {
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      const config = {
        indexing: { embeddings_enabled: true },
        network: { offline: false },
      } as unknown as Config
      const result = checkEmbeddingModel(config)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('model files are missing')
      expect(result.message).toContain('token-goat doctor --repair')
    })

    // PROVENANCE: HAND-DERIVED. The failure message is the describeCause output tests/model_download_gate.test.ts derives from a CAPTURE on node v24.12.0; the expected wording follows from checkEmbeddingModel's branch, and the advice is compared against downloadAdvice() itself, which tests/embed_preflight.test.ts pins variant by variant.
    it('leads with the recorded download failure, its reason and the proxy advice, instead of a bare "run --repair"', () => {
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      const at = Date.UTC(2026, 8, 29, 1, 0, 0)
      recordDownloadFailure(`https://${MODEL_DOWNLOAD_HOST}/x/tokenizer.json`, 'fetch failed (connect ECONNREFUSED 127.0.0.1:9)', at)
      try {
        const config = { indexing: { embeddings_enabled: true }, network: { offline: false } } as unknown as Config
        const result = checkEmbeddingModel(config)
        expect(result.status).toBe('warn')
        expect(result.message).toContain('failed with fetch failed (connect ECONNREFUSED 127.0.0.1:9)')
        expect(result.message).toContain(new Date(at).toISOString())
        expect(result.message).toContain(downloadAdvice())
      } finally {
        clearDownloadFailure(MODEL_DOWNLOAD_HOST)
      }
    })

    it('says the model downloads by itself when no download has failed', () => {
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      const config = { indexing: { embeddings_enabled: true }, network: { offline: false } } as unknown as Config
      expect(checkEmbeddingModel(config).message).toContain('they download by themselves')
    })

    it('returns ok when model files are present', () => {
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)
      const config = {
        indexing: { embeddings_enabled: true },
        network: { offline: false },
      } as unknown as Config
      const result = checkEmbeddingModel(config)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('verified and ready')
    })
  })

  describe('runDoctorRepair', () => {
    it('repairs restrictive settings to permissive defaults', async () => {
      const mockConfig: Config = {
        mcp: { confine_reads_to_project_root: true },
        indexing: { cross_project_symbols: false, embeddings_enabled: true },
        network: { offline: false },
      } as unknown as Config

      vi.spyOn(configModule, 'loadConfig').mockReturnValue(mockConfig)
      const saveSpy = vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)

      const result = await runDoctorRepair({ rootDir: projectRoot })
      expect(result.repairs).toContain('Restored permissive read access (mcp.confine_reads_to_project_root = false)')
      expect(result.repairs).toContain('Restored cross-project symbol search (indexing.cross_project_symbols = true)')
      expect(saveSpy).toHaveBeenCalled()
      const savedConfig = saveSpy.mock.calls[0][0]
      expect(savedConfig.mcp.confine_reads_to_project_root).toBe(false)
      expect(savedConfig.indexing.cross_project_symbols).toBe(true)
    })

    it('repairs offline mode and downloads model when missing due to offline rollout', async () => {
      const mockConfig: Config = {
        mcp: { confine_reads_to_project_root: false },
        indexing: { cross_project_symbols: true, embeddings_enabled: false },
        network: { offline: true },
      } as unknown as Config

      vi.spyOn(configModule, 'loadConfig').mockReturnValue(mockConfig)
      const saveSpy = vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      const ensureSpy = vi.spyOn(embedModel, 'ensureModelFiles').mockResolvedValue('mock-dir')

      const result = await runDoctorRepair({ rootDir: projectRoot })
      expect(result.repairs).toContain('Restored network access (network.offline = false)')
      expect(result.repairs).toContain('Enabled semantic embeddings (indexing.embeddings_enabled = true)')
      expect(result.repairs).toContain('Downloaded and verified semantic embedding model files')
      expect(saveSpy).toHaveBeenCalled()
      expect(ensureSpy).toHaveBeenCalled()
      const savedConfig = saveSpy.mock.calls[0][0]
      expect(savedConfig.network.offline).toBe(false)
      expect(savedConfig.indexing.embeddings_enabled).toBe(true)
    })

    it('downloads the model as an explicit request, which goes through a hold an earlier failure left', async () => {
      const mockConfig = { mcp: { confine_reads_to_project_root: false }, indexing: { cross_project_symbols: true, embeddings_enabled: true }, network: { offline: false } } as unknown as Config
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(mockConfig)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      let explicit: boolean | null = null
      vi.spyOn(embedModel, 'ensureModelFiles').mockImplementation(async () => {
        explicit = isExplicitDownload()
        return 'mock-dir'
      })

      await runDoctorRepair({ rootDir: projectRoot })
      expect(explicit).toBe(true)
    })

    it('adds what to try when the download fails', async () => {
      const mockConfig = { mcp: { confine_reads_to_project_root: false }, indexing: { cross_project_symbols: true, embeddings_enabled: true }, network: { offline: false } } as unknown as Config
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(mockConfig)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      vi.spyOn(embedModel, 'ensureModelFiles').mockRejectedValue(new Error('GET https://huggingface.co/x failed: fetch failed (connect ECONNREFUSED 127.0.0.1:9)'))

      const result = await runDoctorRepair({ rootDir: projectRoot })
      expect(result.errors).toContain(`Failed to download embedding model: GET https://huggingface.co/x failed: fetch failed (connect ECONNREFUSED 127.0.0.1:9). ${downloadAdvice()}`)
    })

    it('reports no repairs when configuration and models are already healthy', async () => {
      const mockConfig: Config = {
        mcp: { confine_reads_to_project_root: false },
        indexing: { cross_project_symbols: true, embeddings_enabled: true },
        network: { offline: false },
      } as unknown as Config

      vi.spyOn(configModule, 'loadConfig').mockReturnValue(mockConfig)
      const saveSpy = vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)
      const ensureSpy = vi.spyOn(embedModel, 'ensureModelFiles').mockResolvedValue('mock-dir')

      const result = await runDoctorRepair({ rootDir: projectRoot })
      expect(result.repairs).toHaveLength(0)
      expect(result.errors).toHaveLength(0)
      expect(saveSpy).not.toHaveBeenCalled()
      expect(ensureSpy).not.toHaveBeenCalled()
    })

    it('repairs stale hook shims when an installed harness has outdated shim content', async () => {
      const mockConfig: Config = {
        mcp: { confine_reads_to_project_root: false },
        indexing: { cross_project_symbols: true, embeddings_enabled: true },
        network: { offline: false },
      } as unknown as Config

      vi.spyOn(configModule, 'loadConfig').mockReturnValue(mockConfig)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)

      // Seed a project-scoped Copilot CLI hooks directory with a stale shim and valid config
      const hooksDir = path.join(projectRoot, '.github', 'hooks')
      fs.mkdirSync(hooksDir, { recursive: true })
      const shimPath = path.join(hooksDir, 'token-goat-shim.cjs')
      fs.writeFileSync(shimPath, '# old stale shim content\nexit 0\n', 'utf8')
      const configPath = path.join(hooksDir, 'hooks.json')
      fs.writeFileSync(configPath, JSON.stringify({ hooks: { preToolUse: [] } }), 'utf8')

      const result = await runDoctorRepair({ rootDir: projectRoot })
      expect(result.repairs.some((r) => r.includes('Copilot CLI (project)'))).toBe(true)
      const repairedShim = fs.readFileSync(shimPath, 'utf8')
      expect(repairedShim).not.toContain('old stale shim content')
    })

    describe('Copilot CLI hook repair', () => {
      // The stale bytes below are HAND-DERIVED: a shim and a hook command written independently of the matcher, so the repair has something real to undo. The "current" side is whatever installCopilotHooksFile writes, compared against COPILOT_CLI_HOOK_SCRIPT, the constant the shim is generated from.
      const STALE_SHIM = '// old stale shim content\n'
      const STALE_COMMAND = 'node /old/location/token-goat-shim.cjs preToolUse'

      beforeEach(() => {
        const mockConfig = { mcp: { confine_reads_to_project_root: false }, indexing: { cross_project_symbols: true, embeddings_enabled: true }, network: { offline: false } } as unknown as Config
        vi.spyOn(configModule, 'loadConfig').mockReturnValue(mockConfig)
        vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
        vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)
        // The user-scope repair must not look at the checkout the suite runs from, which carries its own .github/copilot-instructions.md.
        vi.spyOn(process, 'cwd').mockReturnValue(projectRoot)
      })

      const seedInstall = (opts: { local?: boolean; projectRoot?: string } = {}): void => {
        installCopilotHooksFile(copilotCliHooksDir(opts), 'copilot')
        writeCopilotInstructionsBlock(copilotCliInstructionsPath(opts))
      }

      const outdateEntry = (opts: { local?: boolean; projectRoot?: string } = {}): void => {
        const file = copilotCliConfigPath(opts)
        const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> }
        config.hooks['preToolUse'][0].command = STALE_COMMAND
        fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
      }

      const copilotRepairs = (repairs: readonly string[]): string[] => repairs.filter((r) => r.includes('Copilot CLI'))

      it('rewrites a stale user-scope shim and names the repair', async () => {
        seedInstall()
        fs.writeFileSync(copilotCliScriptPath(), STALE_SHIM)

        const result = await runDoctorRepair({ rootDir: projectRoot })

        expect(result.errors).toEqual([])
        expect(copilotRepairs(result.repairs)).toEqual(['Repaired Copilot CLI (user) hooks and shim'])
        expect(fs.readFileSync(copilotCliScriptPath(), 'utf8')).toBe(COPILOT_CLI_HOOK_SCRIPT)
      })

      it('rewrites outdated user-scope hook entries when the shim is already current', async () => {
        seedInstall()
        outdateEntry()
        expect(wiredCopilotHookWords().some((e) => !e.current)).toBe(true)

        const result = await runDoctorRepair({ rootDir: projectRoot })

        expect(result.errors).toEqual([])
        expect(copilotRepairs(result.repairs)).toEqual(['Repaired Copilot CLI (user) hooks and shim'])
        const wired = wiredCopilotHookWords()
        expect(wired.length).toBeGreaterThan(0)
        expect(wired.every((e) => e.current)).toBe(true)
        expect(fs.readFileSync(copilotCliConfigPath(), 'utf8')).not.toContain(STALE_COMMAND)
      })

      it('rewrites a stale project-scope shim and outdated entries and names the project repair', async () => {
        const opts = { local: true, projectRoot }
        seedInstall(opts)
        fs.writeFileSync(copilotCliScriptPath(opts), STALE_SHIM)
        outdateEntry(opts)

        const result = await runDoctorRepair({ rootDir: projectRoot })

        expect(result.errors).toEqual([])
        expect(copilotRepairs(result.repairs)).toEqual(['Repaired Copilot CLI (project) hooks and shim'])
        expect(fs.readFileSync(copilotCliScriptPath(opts), 'utf8')).toBe(COPILOT_CLI_HOOK_SCRIPT)
        expect(wiredCopilotHookWords(opts).every((e) => e.current)).toBe(true)
        expect(fs.existsSync(copilotCliConfigPath())).toBe(false)
      })

      it('does not add an MCP server entry the user never installed', async () => {
        seedInstall()
        fs.writeFileSync(copilotCliScriptPath(), STALE_SHIM)

        await runDoctorRepair({ rootDir: projectRoot })

        expect(fs.existsSync(copilotMcpConfigPath())).toBe(false)
      })

      it('leaves a user-written token-goat MCP entry alone and still repairs the hooks', async () => {
        seedInstall()
        fs.writeFileSync(copilotCliScriptPath(), STALE_SHIM)
        const mcpText = JSON.stringify({ mcpServers: { 'token-goat': { command: 'my-own-wrapper' } } }, null, 2) + '\n'
        fs.writeFileSync(copilotMcpConfigPath(), mcpText)

        const result = await runDoctorRepair({ rootDir: projectRoot })

        expect(result.errors).toEqual([])
        expect(copilotRepairs(result.repairs)).toEqual(['Repaired Copilot CLI (user) hooks and shim'])
        expect(fs.readFileSync(copilotMcpConfigPath(), 'utf8')).toBe(mcpText)
      })

      it('does not write a token-goat block into a project instructions file when only user scope is installed', async () => {
        seedInstall()
        fs.writeFileSync(copilotCliScriptPath(), STALE_SHIM)
        const projectInstructions = copilotCliInstructionsPath({ local: true, projectRoot })
        fs.mkdirSync(path.dirname(projectInstructions), { recursive: true })
        fs.writeFileSync(projectInstructions, 'Team rules, written by hand.\n')

        await runDoctorRepair({ rootDir: projectRoot })

        expect(fs.readFileSync(projectInstructions, 'utf8')).toBe('Team rules, written by hand.\n')
        expect(fs.existsSync(copilotCliScriptPath({ local: true, projectRoot }))).toBe(false)
      })

      it('reports no Copilot repair for a current install and rewrites nothing', async () => {
        seedInstall()
        const files = [copilotCliScriptPath(), copilotCliConfigPath(), copilotCliInstructionsPath()]
        const before = files.map((f) => fs.readFileSync(f, 'utf8'))

        const result = await runDoctorRepair({ rootDir: projectRoot })

        expect(result.errors).toEqual([])
        expect(copilotRepairs(result.repairs)).toEqual([])
        expect(files.map((f) => fs.readFileSync(f, 'utf8'))).toEqual(before)
      })
    })

    // Provenance: FORMAT-DERIVED. The key name and its default of false come from the `chat.useClaudeHooks` configuration entry in VS Code 1.136.0's workbench.desktop.main.js (cited at vscodeUsesClaudeHooks); the JSONC comment is a HAND-DERIVED stand-in for a user's own settings.
    it('disables chat.useClaudeHooks in VS Code settings when user-scope VS Code hooks and token-goat Claude Code hooks are installed', async () => {
      const mockConfig: Config = {
        mcp: { confine_reads_to_project_root: false },
        indexing: { cross_project_symbols: true, embeddings_enabled: true },
        network: { offline: false },
        gdrive: { enabled: false },
      } as unknown as Config

      vi.spyOn(configModule, 'loadConfig').mockReturnValue(mockConfig)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)

      const { installVscode, vscodeUserSettingsPath } = await import('../src/bridges/vscode_install.js')
      const { installHooks } = await import('../src/install.js')
      // The user-scope VS Code files land under APPDATA on Windows, so it is pointed at this test's scratch home rather than the worker-wide one later tests share.
      vi.stubEnv('APPDATA', userHome)
      installHooks('user')
      const settings = vscodeUserSettingsPath()
      fs.mkdirSync(path.dirname(settings), { recursive: true })
      fs.writeFileSync(settings, '{\n  // custom\n  "chat.useClaudeHooks": true\n}\n', 'utf8')
      installVscode()
      fs.writeFileSync(settings, '{\n  // custom\n  "chat.useClaudeHooks": true\n}\n', 'utf8')

      const result = await runDoctorRepair({ rootDir: projectRoot })
      expect(result.repairs.some((r) => r.includes('Turned off chat.useClaudeHooks'))).toBe(true)
      const after = fs.readFileSync(settings, 'utf8')
      expect(after).toContain('// custom')
      expect(after).toContain('"chat.useClaudeHooks": false')
    })

    // Provenance: same as the test above; the unwritable settings directory is HAND-DERIVED.
    it('reports an error, not a repair or silence, when chat.useClaudeHooks cannot be turned off', async ({ skip }) => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue({
        mcp: { confine_reads_to_project_root: false },
        indexing: { cross_project_symbols: true, embeddings_enabled: true },
        network: { offline: false },
        gdrive: { enabled: false },
      } as unknown as Config)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)

      const { installVscode, vscodeUserSettingsPath } = await import('../src/bridges/vscode_install.js')
      const { installHooks } = await import('../src/install.js')
      vi.stubEnv('APPDATA', userHome)
      installHooks('user')
      const settings = vscodeUserSettingsPath()
      fs.mkdirSync(path.dirname(settings), { recursive: true })
      installVscode()
      fs.writeFileSync(settings, '{\n  "chat.useClaudeHooks": true\n}\n', 'utf8')
      expect(fs.readFileSync(settings, 'utf8')).toContain('"chat.useClaudeHooks": true')
      if (!denyWrites(path.dirname(settings))) {
        skip('this runner can still write a directory denied to it')
        return
      }
      try {
        const result = await runDoctorRepair({ rootDir: projectRoot })
        expect(result.errors.some((e) => e.includes('Failed to repair VS Code chat.useClaudeHooks'))).toBe(true)
        expect(result.repairs.some((r) => r.includes('Turned off chat.useClaudeHooks'))).toBe(false)
        expect(fs.readFileSync(settings, 'utf8')).toContain('"chat.useClaudeHooks": true')
      } finally {
        allowWrites(path.dirname(settings))
      }
    })

    describe('deprecated .vscode/mcp.json residue cleanup', () => {
      let project: string
      let mcpPath: string
      let dataHome: string

      beforeEach(() => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-repair-mcp-'))
        fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
        mcpPath = path.join(project, '.vscode', 'mcp.json')
        // The created-config ledger lives under dataDir(); point it at a scratch dir so the record/take below cannot touch (or be touched by) the real ledger.
        dataHome = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-repair-datadir-'))
        process.env['LOCALAPPDATA'] = dataHome
        process.env['XDG_DATA_HOME'] = dataHome
        _resetDataDirCacheForTesting()
        seedUpdateCheck()
      })

      afterEach(() => {
        clearUpdateCheck()
        fs.rmSync(project, { recursive: true, force: true })
        fs.rmSync(dataHome, { recursive: true, force: true })
        _resetDataDirCacheForTesting()
      })

      function healthyConfig(): Config {
        return {
          mcp: { confine_reads_to_project_root: false },
          indexing: { cross_project_symbols: true, embeddings_enabled: true },
          network: { offline: false },
        } as unknown as Config
      }

      it('removes an empty residue file token-goat created, and the emptied .vscode dir', async () => {
        fs.writeFileSync(mcpPath, '{"servers": {}}\n')
        recordCreatedConfig(mcpPath)
        vi.spyOn(configModule, 'loadConfig').mockReturnValue(healthyConfig())
        vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
        vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)

        const result = await runDoctorRepair({ rootDir: project })

        expect(result.repairs.some((r) => r.includes('Removed empty deprecated VS Code MCP residue file'))).toBe(true)
        expect(result.errors).toHaveLength(0)
        expect(fs.existsSync(mcpPath)).toBe(false)
        expect(fs.existsSync(path.join(project, '.vscode'))).toBe(false)
      })

      it('leaves an empty residue file token-goat did not create', async () => {
        // Emptiness is not ownership: the same bytes a user left behind are never deleted.
        fs.writeFileSync(mcpPath, '{"servers": {}}\n')
        vi.spyOn(configModule, 'loadConfig').mockReturnValue(healthyConfig())
        vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
        vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)

        const result = await runDoctorRepair({ rootDir: project })

        expect(result.repairs).toHaveLength(0)
        expect(result.errors).toHaveLength(0)
        expect(fs.existsSync(mcpPath)).toBe(true)
      })

      it('leaves a populated .vscode/mcp.json alone', async () => {
        fs.writeFileSync(mcpPath, '{"servers": {"other": {"type": "stdio"}}}\n')
        recordCreatedConfig(mcpPath)
        vi.spyOn(configModule, 'loadConfig').mockReturnValue(healthyConfig())
        vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
        vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)

        const result = await runDoctorRepair({ rootDir: project })

        expect(result.repairs).toHaveLength(0)
        expect(result.errors).toHaveLength(0)
        expect(fs.existsSync(mcpPath)).toBe(true)
      })
    })

    it('reports an available update from a development checkout and installs nothing', async () => {
      // The suite runs from this repository, which is a development checkout, so step 7 must name the update and leave the build alone.
      seedUpdateCheck('99.0.0')
      vi.spyOn(configModule, 'loadConfig').mockReturnValue({
        mcp: { confine_reads_to_project_root: false },
        indexing: { cross_project_symbols: true, embeddings_enabled: true },
        network: { offline: false },
      } as unknown as Config)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)

      const result = await runDoctorRepair({ rootDir: projectRoot })

      const notice = result.repairs.find((r) => r.includes('development checkout'))
      expect(notice).toContain('-> v99.0.0')
      expect(notice).toContain(DEV_CHECKOUT_ADVICE)
      expect(result.repairs.some((r) => r.startsWith('Upgraded'))).toBe(false)
      expect(result.errors.filter((e) => e.includes('pgrade'))).toHaveLength(0)
    })

    it('reports nothing about updates when offline, even with one cached', async () => {
      seedUpdateCheck('99.0.0')
      vi.spyOn(configModule, 'loadConfig').mockReturnValue({
        mcp: { confine_reads_to_project_root: false },
        indexing: { cross_project_symbols: true, embeddings_enabled: true },
        network: { offline: true },
      } as unknown as Config)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)

      const result = await runDoctorRepair({ rootDir: projectRoot })

      expect(result.repairs.filter((r) => r.includes('pdate') || r.includes('pgrade'))).toHaveLength(0)
      expect(result.errors.filter((e) => e.includes('pgrade'))).toHaveLength(0)
    })
  })

  describe('the update notice at the end of a doctor run', () => {
    // HAND-DERIVED: the suite runs from this repository, a development checkout, and the cache says 99.0.0 is out, so the decision is dev-checkout. The notice once said 'Run `token-goat upgrade`' whatever the decision, which upgrade itself refuses from a checkout, and it printed after --fix had already handled the update in step 7.
    async function doctorOutput(opts: { fix?: boolean }): Promise<string> {
      seedUpdateCheck('99.0.0')
      // The full checks run after the repair, so this one needs every section of a real config rather than the few the repair reads.
      const config = configModule.defaultConfig()
      config.network.offline = false
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(config)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => undefined)
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)
      const lines: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
      await runDoctorAndExit({ rootDir: projectRoot, processes: [], ...opts })
      return lines.join('\n')
    }

    it('gives the development-checkout advice instead of telling a checkout to run upgrade', async () => {
      const out = await doctorOutput({})

      expect(out).toContain('[!] Update available: token-goat v')
      expect(out).toContain('-> v99.0.0')
      expect(out).toContain(DEV_CHECKOUT_ADVICE)
      expect(out).not.toContain('Run `token-goat upgrade`')
    })

    it('prints no notice after --fix, whose own step already handled the update', async () => {
      const out = await doctorOutput({ fix: true })

      expect(out).toContain('development checkout')
      expect(out).not.toContain('[!] Update available')
      expect(out).not.toContain('Run `token-goat upgrade`')
    })
  })

  describe('a --fix repair that fails', () => {
    // CAPTURE: `doctor --fix` with a read-only config.toml in a scratch home printed "Repair errors encountered:" and the EPERM line on stdout and exited 0. The failing save is simulated here; the message shape is the one runDoctorRepair builds.
    async function failingFix(): Promise<{ out: string; err: unknown }> {
      const config = configModule.defaultConfig()
      config.network.offline = false
      config.mcp.confine_reads_to_project_root = true
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(config)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => { throw new Error('EPERM: operation not permitted') })
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(true)
      const lines: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
      const err = await runDoctorAndExit({ rootDir: projectRoot, processes: [], fix: true }).then(() => undefined, (e: unknown) => e)
      return { out: lines.join('\n'), err }
    }

    it('fails on stderr naming the repair, after the report, instead of listing it on stdout', async () => {
      const { out, err } = await failingFix()

      expect(err).toBeInstanceOf(CliError)
      expect(formatCommandError(err)).toBe('token-goat: 1 repair failed:\n  ✕ Failed to update configuration: EPERM: operation not permitted. Not applied: Restored permissive read access (mcp.confine_reads_to_project_root = false)')
      expect(out).not.toContain('Repair errors')
      expect(out).not.toContain('EPERM')
      expect(out).toContain('Running automatic repairs')
    })

    // CAPTURE: the same scratch-home run listed "✓ Enabled semantic embeddings (indexing.embeddings_enabled = true)" under "Repairs applied:" although the save that would apply it had failed.
    it('does not list a config repair as applied when the config could not be saved', async () => {
      const { out } = await failingFix()

      expect(out).not.toContain('Restored permissive read access')
      expect(out).toContain('No automatic repairs needed.')
    })

    it('does not download the model against an offline switch it failed to turn off', async () => {
      const config = configModule.defaultConfig()
      config.network.offline = true
      config.indexing.embeddings_enabled = false
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(config)
      vi.spyOn(configModule, 'saveConfig').mockImplementation(() => { throw new Error('EPERM: operation not permitted') })
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      const ensureSpy = vi.spyOn(embedModel, 'ensureModelFiles').mockResolvedValue('mock-dir')

      const result = await runDoctorRepair({ rootDir: projectRoot })

      expect(ensureSpy).not.toHaveBeenCalled()
      expect(result.repairs.filter((r) => r.includes('network.offline') || r.includes('embeddings_enabled'))).toEqual([])
      expect(result.errors[0]).toBe('Failed to update configuration: EPERM: operation not permitted. Not applied: Restored network access (network.offline = false); Enabled semantic embeddings (indexing.embeddings_enabled = true)')
    })
  })

  describe('runDoctorRepair against the real config layering', () => {
    // No loadConfig/saveConfig spies: the repair loads the effective config and saves through the real config module into the isolated TOKEN_GOAT_HOME. Provenance: CAPTURE (a scratch-home run of 2.9.29 where an env var and a repo's .token-goat.toml landed in the global config.toml); 4321 is HAND-DERIVED, inside the 50-100000 clamp of bash_compress.max_lines.
    function writeProjectToml(): void {
      fs.writeFileSync(path.join(projectRoot, '.token-goat.toml'), '[bash_compress]\nmax_lines = 4321\n')
    }

    function captureLog(): string[] {
      const lines: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
      return lines
    }

    afterEach(() => {
      configModule.invalidateConfigCache()
      try { fs.rmSync(configPath(), { force: true }) } catch { /* nothing written */ }
    })

    it('persists neither an env override nor the repo file, and names the variable instead of claiming a fix', async () => {
      writeProjectToml()
      // A global setting the repair does flip, so the save happens and whatever else the effective config carried would ride along with it.
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      fs.writeFileSync(configPath(), '[indexing]\ncross_project_symbols = false\n')
      vi.stubEnv('TOKEN_GOAT_OFFLINE', '1')
      vi.stubEnv('TOKEN_GOAT_REDACTION_STRICT', '1')
      configModule.invalidateConfigCache()
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      const ensureSpy = vi.spyOn(embedModel, 'ensureModelFiles').mockResolvedValue('mock-dir')
      captureLog()

      const result = await runDoctorRepair({ rootDir: projectRoot })

      const saved = fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf8') : ''
      expect(saved).toMatch(/cross_project_symbols\s*=\s*true/)
      expect(saved).not.toContain('4321')
      expect(saved).not.toContain('strict = true')
      expect(result.repairs.join('\n')).not.toContain('Restored network access')
      expect(result.notices.join('\n')).toContain('TOKEN_GOAT_OFFLINE')
      expect(ensureSpy).not.toHaveBeenCalled()
      expect(result.errors).toHaveLength(0)
    })

    it('has the model check name the environment variable rather than advise a repair that cannot lift it', () => {
      vi.stubEnv('TOKEN_GOAT_OFFLINE', '1')
      configModule.invalidateConfigCache()
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)

      const result = checkEmbeddingModel(configModule.loadConfig(projectRoot), projectRoot)

      expect(result.status).toBe('warn')
      expect(result.message).toContain('TOKEN_GOAT_OFFLINE')
      expect(result.message).not.toContain('doctor --repair')
    })

    it('still restores network access when the global file is what turned offline mode on', async () => {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      fs.writeFileSync(configPath(), '[network]\noffline = true\n')
      configModule.invalidateConfigCache()
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      const ensureSpy = vi.spyOn(embedModel, 'ensureModelFiles').mockResolvedValue('mock-dir')
      captureLog()

      const result = await runDoctorRepair({ rootDir: projectRoot })

      expect(result.repairs).toContain('Restored network access (network.offline = false)')
      expect(fs.readFileSync(configPath(), 'utf8')).toMatch(/offline\s*=\s*false/)
      expect(ensureSpy).toHaveBeenCalled()
    })

    it('never persists embeddings_enabled = true over an environment switch that turns embeddings off', async () => {
      vi.stubEnv('TOKEN_GOAT_EMBEDDINGS_ENABLED', '0')
      configModule.invalidateConfigCache()
      vi.spyOn(embedModel, 'modelFilesPresent').mockReturnValue(false)
      vi.spyOn(embedModel, 'ensureModelFiles').mockResolvedValue('mock-dir')
      captureLog()

      const result = await runDoctorRepair({ rootDir: projectRoot })

      const saved = fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf8') : ''
      expect(saved).not.toMatch(/embeddings_enabled\s*=\s*true/)
      expect(result.repairs.join('\n')).not.toContain('Enabled semantic embeddings')
      expect(result.notices.join('\n')).toContain('TOKEN_GOAT_EMBEDDINGS_ENABLED')
    })
  })
})

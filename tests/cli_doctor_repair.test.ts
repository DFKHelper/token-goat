import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Config } from '../src/config.js'
import { checkEmbeddingModel, runDoctorAndExit, runDoctorRepair } from '../src/cli_doctor.js'
import * as embedModel from '../src/embed_model.js'
import * as configModule from '../src/config.js'
import { recordCreatedConfig } from '../src/bridges/created_configs.js'
import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { downloadAdvice } from '../src/embed_preflight.js'
import { MODEL_DOWNLOAD_HOST, clearDownloadFailure, isExplicitDownload, recordDownloadFailure } from '../src/model_download_gate.js'
import { INSTRUCTION_GATE_BEGIN, INSTRUCTION_GATE_END } from '../src/cli_doctor_guidance.js'
import { DEV_CHECKOUT_ADVICE } from '../src/cli_upgrade.js'
import { clearUpdateCheck, seedUpdateCheck } from './helpers/update-check.js'

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

    describe('deprecated .vscode/mcp.json residue cleanup', () => {
      let project: string
      let mcpPath: string
      let dataHome: string

      beforeEach(() => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-repair-mcp-'))
        fs.mkdirSync(path.join(project, '.vscode'), { recursive: true })
        mcpPath = path.join(project, '.vscode', 'mcp.json')
        // The created-config ledger lives under dataDir(); point it at a scratch dir so the
        // record/take below cannot touch (or be touched by) the real ledger.
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
    // HAND-DERIVED: the suite runs from this repository, a development checkout, and the cache says 99.0.0 is out, so the decision is dev-checkout. The notice once said "Run 'token-goat upgrade'" whatever the decision, which upgrade itself refuses from a checkout, and it printed after --fix had already handled the update in step 7.
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
      expect(out).not.toContain("Run 'token-goat upgrade'")
    })

    it('prints no notice after --fix, whose own step already handled the update', async () => {
      const out = await doctorOutput({ fix: true })

      expect(out).toContain('development checkout')
      expect(out).not.toContain('[!] Update available')
      expect(out).not.toContain("Run 'token-goat upgrade'")
    })
  })
})

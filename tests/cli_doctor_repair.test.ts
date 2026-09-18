import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { checkEmbeddingModel, runDoctorRepair } from '../src/cli_doctor.js'
import * as embedModel from '../src/embed_model.js'
import * as configModule from '../src/config.js'

describe('doctor auto-repair and embedding model checks', () => {
  beforeEach(() => {
    delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
    vi.restoreAllMocks()
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

      const result = await runDoctorRepair()
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

      const result = await runDoctorRepair()
      expect(result.repairs).toContain('Restored network access (network.offline = false)')
      expect(result.repairs).toContain('Enabled semantic embeddings (indexing.embeddings_enabled = true)')
      expect(result.repairs).toContain('Downloaded and verified semantic embedding model files')
      expect(saveSpy).toHaveBeenCalled()
      expect(ensureSpy).toHaveBeenCalled()
      const savedConfig = saveSpy.mock.calls[0][0]
      expect(savedConfig.network.offline).toBe(false)
      expect(savedConfig.indexing.embeddings_enabled).toBe(true)
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

      const result = await runDoctorRepair()
      expect(result.repairs).toHaveLength(0)
      expect(result.errors).toHaveLength(0)
      expect(saveSpy).not.toHaveBeenCalled()
      expect(ensureSpy).not.toHaveBeenCalled()
    })
  })
})

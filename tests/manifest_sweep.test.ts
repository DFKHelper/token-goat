import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { registerAnalysisCommands, type GuardFn } from '../src/cli_cmd_analysis.js'
import { collectManifestSweep } from '../src/manifest_sweep.js'

function createRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-manifest-sweep-'))
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value) + '\n', 'utf8')
}

function withRoot(run: (root: string) => void): void {
  const root = createRoot()
  try {
    run(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function withRootAsync(run: (root: string) => Promise<void>): Promise<void> {
  const root = createRoot()
  try {
    await run(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe('manifest-sweep', () => {
  it('is reachable through the analysis command registration', async () => {
    await withRootAsync(async (root) => {
      writeJson(path.join(root, 'package.json'), { name: 'registered-project', dependencies: { express: '^4.0.0' } })
      const program = new Command()
      program.exitOverride()
      const guard: GuardFn = (fn) => async () => {
        await fn()
      }

      registerAnalysisCommands(program, guard)
      await program.parseAsync(['node', 'token-goat', 'manifest-sweep', root, '--json'])

      expect(program.commands.some((command) => command.name() === 'manifest-sweep')).toBe(true)
    })
  })

  it('summarizes nested declarations and exact direct lockfile coordinates without traversing installed or hidden directories', () => {
    withRoot((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'workspace',
        version: '1.0.0',
        dependencies: { express: '^4.18.0' },
        devDependencies: { vitest: '^3.0.0' },
      })
      writeJson(path.join(root, 'package-lock.json'), {
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'workspace',
            version: '1.0.0',
            dependencies: { express: '^4.18.0' },
            devDependencies: { vitest: '^3.0.0' },
          },
          'node_modules/express': { version: '4.18.2' },
          'node_modules/vitest': { version: '3.0.5' },
          'node_modules/express/node_modules/safe-buffer': { version: '5.2.1' },
        },
      })
      writeJson(path.join(root, 'services', 'api', 'package.json'), {
        name: '@example/api',
        version: '2.0.0',
        dependencies: { express: '^5.0.0' },
      })
      writeJson(path.join(root, 'services', 'api', 'package-lock.json'), {
        lockfileVersion: 3,
        packages: {
          '': { name: '@example/api', dependencies: { express: '^5.0.0' } },
          'node_modules/express': { version: '5.0.1' },
        },
      })
      writeJson(path.join(root, '.scratch', 'hidden', 'package.json'), { name: 'hidden' })
      writeJson(path.join(root, 'node_modules', 'ignored', 'package.json'), { name: 'ignored' })

      const report = collectManifestSweep({ root })

      expect(report.manifests.map((manifest) => manifest.path)).toEqual([
        'package.json',
        'services/api/package.json',
      ])
      expect(report.summary).toMatchObject({ manifests: 2, lockfiles: 2, resolvedCoordinates: 3 })
      expect(report.manifests[0]?.dependencies).toContainEqual({
        name: 'express',
        range: '^4.18.0',
        section: 'dependencies',
      })
      expect(report.manifests[0]?.lockfiles[0]?.coordinates).toEqual([
        { name: 'express', version: '4.18.2', kind: 'direct' },
        { name: 'vitest', version: '3.0.5', kind: 'direct' },
      ])
    })
  })

  it('filters by exact package name and reports transitive resolved versions across service lockfiles', () => {
    withRoot((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'workspace',
        dependencies: { express: '^4.18.0' },
      })
      writeJson(path.join(root, 'package-lock.json'), {
        lockfileVersion: 3,
        packages: {
          '': { name: 'workspace', dependencies: { express: '^4.18.0' } },
          'node_modules/express': { version: '4.18.2' },
          'node_modules/parent/node_modules/express': { version: '4.17.3' },
        },
      })
      writeJson(path.join(root, 'services', 'api', 'package.json'), {
        name: 'api',
        dependencies: { express: '^5.0.0' },
      })
      writeJson(path.join(root, 'services', 'api', 'package-lock.json'), {
        lockfileVersion: 3,
        packages: {
          '': { name: 'api', dependencies: { express: '^5.0.0' } },
          'node_modules/express': { version: '5.0.1' },
        },
      })

      const report = collectManifestSweep({ root, packageName: 'express' })
      expect(report.scannedManifests).toBe(2)
      expect(report.manifests.map((manifest) => manifest.path)).toEqual([
        'package.json',
        'services/api/package.json',
      ])
      expect(report.manifests[0]?.lockfiles[0]?.coordinates).toEqual([
        { name: 'express', version: '4.17.3', kind: 'transitive' },
        { name: 'express', version: '4.18.2', kind: 'direct' },
      ])
      expect(collectManifestSweep({ root, packageName: 'exp' }).manifests).toEqual([])
    })
  })

  it('fails visibly on malformed manifests and over-depth roots instead of returning a partial inventory', () => {
    withRoot((root) => {
      fs.writeFileSync(path.join(root, 'package.json'), '{\n', 'utf8')
      expect(() => collectManifestSweep({ root })).toThrow(/Invalid package manifest/)
    })

    withRoot((root) => {
      const deepDirectory = path.join(root, ...Array.from({ length: 34 }, (_, index) => `d${index}`))
      fs.mkdirSync(deepDirectory, { recursive: true })
      writeJson(path.join(deepDirectory, 'package.json'), { name: 'too-deep' })
      expect(() => collectManifestSweep({ root })).toThrow(/depth limit/)
    })
  })
})

import * as fs from 'node:fs'
import * as path from 'node:path'
import type * as NodeOs from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'
import {
  installAider,
  uninstallAider,
  isAiderInstalled,
  aiderConventionsPath,
  AIDER_CONVENTIONS_BEGIN,
  AIDER_CONVENTIONS_END,
} from '../src/bridges/aider_install.js'
import { detectEcosystems } from '../src/bridges/detect_ecosystems.js'

let TMP: string
let PROJ_DIR: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-aider-test-home-'))
  PROJ_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-aider-test-proj-'))
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(TMP)
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(PROJ_DIR, { recursive: true, force: true })
})

describe('aiderConventionsPath', () => {
  it('resolves project conventions to CONVENTIONS.md in project root', () => {
    expect(aiderConventionsPath({ project: true, projectRoot: PROJ_DIR })).toBe(
      path.join(PROJ_DIR, 'CONVENTIONS.md'),
    )
  })

  it('resolves user conventions to ~/.aider.conventions.md', () => {
    expect(aiderConventionsPath({ project: false })).toBe(
      path.join(TMP, '.aider.conventions.md'),
    )
  })
})

describe('installAider', () => {
  it('installs project-scope conventions into CONVENTIONS.md', () => {
    const res = installAider({ project: true, projectRoot: PROJ_DIR })
    expect(res.alreadyInstalled).toBe(false)
    expect(res.scope).toBe('project')
    expect(res.conventionsPath).toBe(path.join(PROJ_DIR, 'CONVENTIONS.md'))
    expect(fs.existsSync(res.conventionsPath)).toBe(true)

    const content = fs.readFileSync(res.conventionsPath, 'utf8')
    expect(content).toContain(AIDER_CONVENTIONS_BEGIN)
    expect(content).toContain(AIDER_CONVENTIONS_END)
    expect(content).toContain('token-goat')
    expect(content).toContain("Aider's own file-reading")
  })

  it('is idempotent and reports alreadyInstalled on second run', () => {
    installAider({ project: true, projectRoot: PROJ_DIR })
    const res2 = installAider({ project: true, projectRoot: PROJ_DIR })
    expect(res2.alreadyInstalled).toBe(true)
  })

  it('preserves surrounding user content in pre-existing CONVENTIONS.md', () => {
    const filePath = path.join(PROJ_DIR, 'CONVENTIONS.md')
    fs.writeFileSync(filePath, '# Custom Project Rules\n\n- Run linter before commit\n', 'utf8')

    installAider({ project: true, projectRoot: PROJ_DIR })
    const content = fs.readFileSync(filePath, 'utf8')
    expect(content).toContain('# Custom Project Rules')
    expect(content).toContain('- Run linter before commit')
    expect(content).toContain(AIDER_CONVENTIONS_BEGIN)
    expect(content).toContain(AIDER_CONVENTIONS_END)
  })

  it('installs user-scope conventions into ~/.aider.conventions.md', () => {
    const res = installAider({ project: false })
    expect(res.scope).toBe('user')
    expect(res.conventionsPath).toBe(path.join(TMP, '.aider.conventions.md'))
    expect(fs.existsSync(res.conventionsPath)).toBe(true)

    const content = fs.readFileSync(res.conventionsPath, 'utf8')
    expect(content).toContain(AIDER_CONVENTIONS_BEGIN)
    expect(content).toContain(AIDER_CONVENTIONS_END)
  })
})

describe('isAiderInstalled', () => {
  it('returns false when no conventions file exists', () => {
    expect(isAiderInstalled({ project: true, projectRoot: PROJ_DIR })).toBe(false)
    expect(isAiderInstalled({ project: false })).toBe(false)
  })

  it('returns true after installation in respective scopes', () => {
    installAider({ project: true, projectRoot: PROJ_DIR })
    expect(isAiderInstalled({ project: true, projectRoot: PROJ_DIR })).toBe(true)
    expect(isAiderInstalled({ project: false })).toBe(false)

    installAider({ project: false })
    expect(isAiderInstalled({ project: false })).toBe(true)
  })
})

describe('uninstallAider', () => {
  it('removes token-goat block and deletes the file if empty', () => {
    installAider({ project: true, projectRoot: PROJ_DIR })
    const targetFile = path.join(PROJ_DIR, 'CONVENTIONS.md')
    expect(fs.existsSync(targetFile)).toBe(true)

    const removed = uninstallAider({ project: true, projectRoot: PROJ_DIR })
    expect(removed).toBe(true)
    expect(fs.existsSync(targetFile)).toBe(false)
    expect(isAiderInstalled({ project: true, projectRoot: PROJ_DIR })).toBe(false)
  })

  it('preserves user content and only removes the delimited block', () => {
    const targetFile = path.join(PROJ_DIR, 'CONVENTIONS.md')
    fs.writeFileSync(targetFile, '# Preserved User Conventions\n\n', 'utf8')
    installAider({ project: true, projectRoot: PROJ_DIR })

    const removed = uninstallAider({ project: true, projectRoot: PROJ_DIR })
    expect(removed).toBe(true)
    expect(fs.existsSync(targetFile)).toBe(true)
    const content = fs.readFileSync(targetFile, 'utf8')
    expect(content).toContain('# Preserved User Conventions')
    expect(content).not.toContain(AIDER_CONVENTIONS_BEGIN)
    expect(content).not.toContain(AIDER_CONVENTIONS_END)
  })

  it('returns false when nothing was installed', () => {
    expect(uninstallAider({ project: true, projectRoot: PROJ_DIR })).toBe(false)
  })
})

describe('detectEcosystems for Aider', () => {
  it('detects Aider when CONVENTIONS.md exists in project', () => {
    installAider({ project: true, projectRoot: PROJ_DIR })
    const result = detectEcosystems({ projectRoot: PROJ_DIR })
    const aiderItem = result.items.find((i) => i.id === 'aider')
    expect(aiderItem).toBeDefined()
    expect(aiderItem?.detected).toBe(true)
  })

  it('detects Aider when .aider.conf.yml exists in project', () => {
    fs.writeFileSync(path.join(PROJ_DIR, '.aider.conf.yml'), 'model: gpt-4o\n')
    const result = detectEcosystems({ projectRoot: PROJ_DIR })
    const aiderItem = result.items.find((i) => i.id === 'aider')
    expect(aiderItem).toBeDefined()
    expect(aiderItem?.detected).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildBootstrapAudit, runBootstrapAudit } from '../src/cli_bootstrap_audit.js'

describe('bootstrap-audit', () => {
  it('audits frontmatter only, sorts largest entries, and applies budgets', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-bootstrap-'))
    const project = path.join(root, 'project')
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'project startup guidance\n')
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'small.md'), '---\ndescription: abc\ntools: Read\n---\nSECRET PROMPT BODY\n')
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'nested', 'large.md'), '---\ndescription: a much larger description\ntools: Read, Write\n---\nSECRET PROMPT BODY\n')
    const result = await buildBootstrapAudit({ project, home, top: 1, failTokens: 0 })
    expect(result.counts.metadata_files).toBe(2)
    expect(result.largest).toHaveLength(1)
    expect(result.largest[0].path.endsWith('large.md')).toBe(true)
    expect(result.largest[0]).not.toHaveProperty('body')
    expect(result.budgets.failures).toHaveLength(1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('uses --home for global CLAUDE.md and project MEMORY.md lookup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-bootstrap-home-'))
    const project = path.join(root, 'project')
    const home = path.join(root, 'home')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'project\n')
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'global\n')
    const slug = path.resolve(project).replace(/[^A-Za-z0-9]/g, '-')
    fs.mkdirSync(path.join(home, '.claude', 'projects', slug, 'memory'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'projects', slug, 'memory', 'MEMORY.md'), 'memory\n')
    const result = await buildBootstrapAudit({ project, home })
    expect(result.claude_md_tokens).toBeGreaterThan(0)
    expect(result.memory_md_tokens).toBeGreaterThan(0)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reports broken links without failing the scan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-bootstrap-links-'))
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.symlinkSync(path.join(home, 'missing.md'), path.join(home, '.claude', 'agents', 'broken.md'))
    const result = await buildBootstrapAudit({ project: root, home })
    expect(result.diagnostics.some((d) => d.reason.includes('broken'))).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('deduplicates canonical files reached through a directory link', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-bootstrap-dedupe-'))
    const home = path.join(root, 'home')
    const agents = path.join(home, '.claude', 'agents')
    const realDir = path.join(agents, 'real')
    const aliasDir = path.join(agents, 'alias')
    fs.mkdirSync(realDir, { recursive: true })
    fs.writeFileSync(path.join(realDir, 'data-engineer.md'), '---\ndescription: one canonical entry\n---\nPRIVATE PROMPT BODY\n')
    try {
      fs.symlinkSync(realDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const result = await buildBootstrapAudit({ project: root, home })
    expect(result.counts.metadata_files).toBe(1)
    expect(result.largest).toHaveLength(1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('accepts top-level linked agent roots but rejects nested escaping links', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-bootstrap-boundary-'))
    const home = path.join(root, 'home')
    const agents = path.join(home, '.claude', 'agents')
    const outside = path.join(root, 'outside')
    const escaped = path.join(root, 'escaped')
    fs.mkdirSync(agents, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.mkdirSync(escaped, { recursive: true })
    const linkedDir = path.join(outside, 'linked-dir')
    const directFile = path.join(outside, 'direct.md')
    fs.mkdirSync(linkedDir)
    fs.writeFileSync(path.join(linkedDir, 'legitimate.md'), '---\ndescription: legitimate linked directory entry\n---\nPRIVATE PROMPT BODY\n')
    fs.writeFileSync(path.join(escaped, 'escape.md'), '---\ndescription: escaped entry\n---\nPRIVATE PROMPT BODY\n')
    fs.writeFileSync(directFile, '---\ndescription: legitimate linked file entry\n---\nPRIVATE PROMPT BODY\n')
    try {
      fs.symlinkSync(linkedDir, path.join(agents, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir')
      fs.symlinkSync(directFile, path.join(agents, 'direct.md'), 'file')
      fs.symlinkSync(path.join(escaped, 'escape.md'), path.join(linkedDir, 'nested-escape.md'), 'file')
    } catch {
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const skipped = await buildBootstrapAudit({ project: root, home })
    expect(skipped.counts.agents).toBe(0)
    expect(skipped.diagnostics.some((d) => d.reason.includes('external link skipped'))).toBe(true)
    const result = await buildBootstrapAudit({ project: root, home, followLinks: true })
    expect(result.counts.agents).toBe(2)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('rejects an external agents root link by default and follows it with opt-in', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-bootstrap-root-link-'))
    const home = path.join(root, 'home')
    const externalAgents = path.join(root, 'external-agents')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.mkdirSync(externalAgents, { recursive: true })
    fs.writeFileSync(path.join(externalAgents, 'linked.md'), '---\ndescription: linked root entry\n---\nPRIVATE PROMPT BODY\n')
    try {
      fs.symlinkSync(externalAgents, path.join(home, '.claude', 'agents'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const skipped = await buildBootstrapAudit({ project: root, home })
    expect(skipped.counts.agents).toBe(0)
    expect(skipped.diagnostics.some((d) => d.reason.includes('external root link skipped'))).toBe(true)
    const followed = await buildBootstrapAudit({ project: root, home, followLinks: true })
    expect(followed.counts.agents).toBe(1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('does not treat indented block-scalar fences as frontmatter closing fences', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-bootstrap-fence-'))
    const home = path.join(root, 'home')
    const agents = path.join(home, '.claude', 'agents')
    fs.mkdirSync(agents, { recursive: true })
    fs.writeFileSync(
      path.join(agents, 'block.md'),
      '---\ndescription: |\n  line one\n  ---\n  line two\n---\nPRIVATE PROMPT BODY\n',
    )
    const result = await buildBootstrapAudit({ project: root, home })
    expect(result.counts.metadata_files).toBe(1)
    expect(result.largest[0]?.description_bytes).toBe(Buffer.byteLength('|\nline one\n---\nline two'))
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('emits structured JSON without prompt bodies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-goat-bootstrap-json-'))
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'one.md'), '---\ndescription: safe metadata\n---\nPRIVATE PROMPT BODY\n')
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      await runBootstrapAudit({ project: root, home, json: true })
      const output = JSON.parse(writes.join(''))
      expect(output.counts.metadata_files).toBe(1)
      expect(writes.join('')).not.toContain('PRIVATE PROMPT BODY')
    } finally {
      write.mockRestore()
      process.exitCode = undefined
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

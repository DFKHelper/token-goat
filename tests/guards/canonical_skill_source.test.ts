/** The skill `token-goat install` writes to `~/.claude/skills/token-goat/SKILL.md` ships as a gzip+base64 blob in src/canonical_skill.ts, which nobody can review or edit, so an improvement once landed by hand in an installed copy and the next install overwrote it with the older text. src/canonical_skill.md is the readable source and scripts/generate-canonical-skill.mjs writes the blob from it; these cases fail when the two disagree. PROVENANCE: CAPTURE -- the generator cases spawn the real script, against the repo and against a copy of it. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { CANONICAL_SKILL_MD } from '../../src/canonical_skill.js'
import { extractCompactFromMarker } from '../../src/skill_cache.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join('scripts', 'generate-canonical-skill.mjs')
const SOURCE = path.join('src', 'canonical_skill.md')
const OUT = path.join('src', 'canonical_skill.ts')
const COMPACT_END_MARKER = '<!-- COMPACT_END -->'
const MAX_COMPACT_PREFIX_BYTES = 2400

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
})

function runGenerator(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [path.join(root, SCRIPT), ...args], { cwd: root, encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

describe('canonical skill source', () => {
  it('ships exactly the text in src/canonical_skill.md', () => {
    expect(CANONICAL_SKILL_MD).toBe(fs.readFileSync(path.join(REPO, SOURCE), 'utf8'))
  })

  it('keeps one compact marker within the generator byte budget', () => {
    const compact = extractCompactFromMarker(CANONICAL_SKILL_MD)
    expect(compact).not.toBeNull()
    expect(Buffer.byteLength(compact ?? '', 'utf8')).toBeLessThanOrEqual(MAX_COMPACT_PREFIX_BYTES)
    expect(compact).toContain('Always, before a file read')
    expect(CANONICAL_SKILL_MD.split(COMPACT_END_MARKER)[1]).toMatch(/^\s*## token-goat/m)
  })

  it('has a blob the generator reports as up to date', () => {
    const run = runGenerator(REPO, ['--check'])
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('up to date')
  })

  // Copies the script and its two files so the stale case is a real edit, not one made in place under every other test file running in parallel.
  it('reports a stale blob, and a regenerated one decodes to the edited source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-canonical-skill-'))
    scratch.push(root)
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.mkdirSync(path.join(root, 'src'))
    fs.copyFileSync(path.join(REPO, SCRIPT), path.join(root, SCRIPT))
    fs.copyFileSync(path.join(REPO, 'scripts', 'is-main-module.mjs'), path.join(root, 'scripts', 'is-main-module.mjs'))
    fs.copyFileSync(path.join(REPO, OUT), path.join(root, OUT))
    const edited = `${fs.readFileSync(path.join(REPO, SOURCE), 'utf8')}\nAn edit the blob has not seen.\n`
    fs.writeFileSync(path.join(root, SOURCE), edited)

    const stale = runGenerator(root, ['--check'])
    expect(stale.status, stale.stdout).toBe(1)
    expect(stale.stderr).toContain('stale')

    const write = runGenerator(root, [])
    expect(write.status, write.stderr).toBe(0)
    expect(runGenerator(root, ['--check']).status).toBe(0)

    const decode = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "import('./scripts/generate-canonical-skill.mjs').then((m) => process.stdout.write(m.decodeGeneratedFile()))"],
      { cwd: root, encoding: 'utf8' },
    )
    expect(decode.stdout).toBe(edited)
  })

  it('validates compact boundaries against markdown fences and exact UTF-8 bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-canonical-skill-'))
    scratch.push(root)
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.mkdirSync(path.join(root, 'src'))
    for (const file of [SCRIPT, path.join('scripts', 'is-main-module.mjs'), SOURCE, OUT]) {
      fs.copyFileSync(path.join(REPO, file), path.join(root, file))
    }

    const sourcePath = path.join(root, SOURCE)
    const outputPath = path.join(root, OUT)
    const originalSource = fs.readFileSync(sourcePath, 'utf8')
    const originalOutput = fs.readFileSync(outputPath, 'utf8')

    fs.writeFileSync(sourcePath, `${COMPACT_END_MARKER}\n`)
    const empty = runGenerator(root, [])
    expect(empty.status).toBe(1)
    expect(empty.stderr).toContain('non-empty compact slice')
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(originalOutput)

    fs.writeFileSync(sourcePath, originalSource.replace(/^<!-- COMPACT_END -->\r?\n/m, ''))
    const missing = runGenerator(root, [])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('exactly one standalone')
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(originalOutput)

    const onlyFenced = originalSource.replace(
      COMPACT_END_MARKER,
      `~~~md\n${COMPACT_END_MARKER}\n~~~`,
    )
    fs.writeFileSync(sourcePath, onlyFenced)
    const fencedOnly = runGenerator(root, [])
    expect(fencedOnly.status).toBe(1)
    expect(fencedOnly.stderr).toContain('found 0')
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(originalOutput)

    const fencedExamples = originalSource.replace(
      COMPACT_END_MARKER,
      `\`\`\`md\n${COMPACT_END_MARKER}\n\`\`\`\n~~~md\n${COMPACT_END_MARKER}\n~~~\n${COMPACT_END_MARKER}`,
    )
    fs.writeFileSync(sourcePath, fencedExamples)
    expect(runGenerator(root, []).status).toBe(0)
    expect(runGenerator(root, ['--check']).status).toBe(0)

    const exactCrlfPrefix = `${'a'.repeat(1199)}\r\n${'b'.repeat(1199)}\r\n${COMPACT_END_MARKER}\r\n`
    fs.writeFileSync(sourcePath, exactCrlfPrefix)
    expect(runGenerator(root, []).status).toBe(0)
    const exactOutput = fs.readFileSync(outputPath, 'utf8')

    const oversizedUtf8Prefix = `${'a'.repeat(1199)}\r\n${'b'.repeat(1198)}é\r\n${COMPACT_END_MARKER}\r\n`
    fs.writeFileSync(sourcePath, oversizedUtf8Prefix)
    const oversized = runGenerator(root, ['--check'])
    expect(oversized.status).toBe(1)
    expect(oversized.stderr).toContain('2400-byte limit')
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(exactOutput)
  })

  it('rejects an unknown argument without writing anything', () => {
    const before = fs.readFileSync(path.join(REPO, OUT), 'utf8')
    const run = runGenerator(REPO, ['--chek'])
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('usage:')
    expect(fs.readFileSync(path.join(REPO, OUT), 'utf8')).toBe(before)
  })
})

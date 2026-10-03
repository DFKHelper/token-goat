/** The skill `token-goat install` writes to `~/.claude/skills/token-goat/SKILL.md` ships as a gzip+base64 blob in src/canonical_skill.ts, which nobody can review or edit, so an improvement once landed by hand in an installed copy and the next install overwrote it with the older text. src/canonical_skill.md is the readable source and scripts/generate-canonical-skill.mjs writes the blob from it; these cases fail when the two disagree. PROVENANCE: CAPTURE -- the generator cases spawn the real script, against the repo and against a copy of it. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { CANONICAL_SKILL_MD } from '../../src/canonical_skill.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join('scripts', 'generate-canonical-skill.mjs')
const SOURCE = path.join('src', 'canonical_skill.md')
const OUT = path.join('src', 'canonical_skill.ts')

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

  it('rejects an unknown argument without writing anything', () => {
    const before = fs.readFileSync(path.join(REPO, OUT), 'utf8')
    const run = runGenerator(REPO, ['--chek'])
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('usage:')
    expect(fs.readFileSync(path.join(REPO, OUT), 'utf8')).toBe(before)
  })
})

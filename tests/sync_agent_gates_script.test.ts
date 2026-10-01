import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGuidanceBody } from '../src/bridges/guidance_block.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(repoRoot, 'scripts', 'sync-agent-gates.mjs')
const START = '<!-- token-goat:agent-gate:start -->'
const END = '<!-- token-goat:agent-gate:end -->'
const clause = "Claude Code's own Read, Grep, and Glob preference rules"

// HAND-DERIVED: agent files written for this test from the shape of the repo's own .claude/agents files (prose, then a trailing legacy gate section); the stale gate text is a shortened copy of the pre-sync gate, with none of the newer failure shapes.
const intro = '---\nname: sample-agent\n---\n\nDo the work.\n\n'
const legacy = intro + '## Read gate (mandatory)\n\nBefore every file read, answer one question first.\n\n- reading one heading of a large doc: `token-goat section "file::Heading"`\n'

let dir: string
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-agent-gates-'))
  fs.writeFileSync(path.join(dir, 'a.md'), legacy)
  fs.writeFileSync(path.join(dir, 'b.md'), intro + 'No gate here.\n')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('scripts/sync-agent-gates.mjs', () => {
  it('fails --check on a stale gate and writes nothing', () => {
    const r = run('--check', dir)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('a.md')
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe(legacy)
  })

  it('renders the canonical body between markers and keeps the text outside byte-identical', () => {
    expect(run(dir).status).toBe(0)
    const after = fs.readFileSync(path.join(dir, 'a.md'), 'utf8')
    expect(after).toBe(intro + START + '\n' + buildGuidanceBody(clause) + '\n' + END + '\n')
    expect(after).toContain('image-text')
  })

  it('leaves a file with no gate alone', () => {
    run(dir)
    expect(fs.readFileSync(path.join(dir, 'b.md'), 'utf8')).toBe(intro + 'No gate here.\n')
  })

  it('is idempotent and passes --check afterwards', () => {
    run(dir)
    const once = fs.readFileSync(path.join(dir, 'a.md'), 'utf8')
    expect(run(dir).stdout).toBe('')
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe(once)
    expect(run('--check', dir).status).toBe(0)
  })

  it('replaces only the marked region once markers exist', () => {
    run(dir)
    const file = path.join(dir, 'a.md')
    const edited = fs.readFileSync(file, 'utf8').replace('Do the work.', 'Do other work.').replace('Flat counts', 'Stale counts') + '\nTrailer.\n'
    fs.writeFileSync(file, edited)
    expect(run('--check', dir).status).toBe(1)
    run(dir)
    const fixed = fs.readFileSync(file, 'utf8')
    expect(fixed).toContain('Do other work.')
    expect(fixed).toContain('Flat counts')
    expect(fixed).not.toContain('Stale counts')
    expect(fixed).toContain('Trailer.')
  })

  it('exits 0 when the agents directory does not exist', () => {
    expect(run('--check', path.join(dir, 'missing')).status).toBe(0)
  })
})

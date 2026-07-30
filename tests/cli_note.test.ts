/**
 * CLI coverage for the architecture-notes feature: `note-add` / `note-get` / `note-list`.
 * Mirrors the `insert-section` describe block in tests/cli.test.ts -- spawns the real built
 * bundle (runCli, dist/token-goat.mjs) against real scratch files, so this exercises the actual
 * shipping command wiring (arg parsing, option flags, exit codes), not just the pure notes.ts
 * layer already covered by tests/notes.test.ts.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { normalizePath } from '../src/paths.js'
import { runCli } from './helpers/bundle.js'

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

describe('note-add / note-get / note-list', () => {
  it('note-add --help / note-get --help / note-list --help exit 0', () => {
    for (const cmd of ['note-add', 'note-get', 'note-list']) {
      const r = runCli([cmd, '--help'])
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain(cmd)
    }
  })

  it('note-add attaches a whole-file note and note-get reads it back, stale=false', () => {
    const tmp = path.join(os.tmpdir(), `tg-note-file-${Date.now()}.md`)
    fs.writeFileSync(tmp, '# A doc with no indexed symbols\n', 'utf8')
    try {
      const add = runCli(['note-add', tmp, '--content-b64', b64('This doc explains X.')])
      expect(add.status, add.stderr).toBe(0)
      expect(add.stdout).toContain('Note saved')
      expect(add.stdout).toContain(tmp)

      const get = runCli(['note-get', tmp])
      expect(get.status, get.stderr).toBe(0)
      expect(get.stdout).toContain('This doc explains X.')
      expect(get.stdout).not.toContain('STALE')

      const getJson = runCli(['note-get', tmp, '--json'])
      expect(getJson.status, getJson.stderr).toBe(0)
      const parsed = JSON.parse(getJson.stdout) as { content: string; stale: boolean; symbol: string | null }
      expect(parsed.content).toBe('This doc explains X.')
      expect(parsed.stale).toBe(false)
      expect(parsed.symbol).toBeNull()
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('note-add --symbol attaches a note to one indexed symbol, resolved on demand (never explicitly indexed)', () => {
    const tmp = path.join(os.tmpdir(), `tg-note-sym-${Date.now()}.ts`)
    fs.writeFileSync(
      tmp,
      'export function noteTargetFn9k(): number {\n  return 1\n}\n' +
        'export function otherFn9k(): number {\n  return 2\n}\n',
    )
    try {
      const add = runCli(['note-add', tmp, '--symbol', 'noteTargetFn9k', '--content-b64', b64('Why this exists.')])
      expect(add.status, add.stderr).toBe(0)
      expect(add.stdout).toContain('noteTargetFn9k')

      const get = runCli(['note-get', tmp, '--symbol', 'noteTargetFn9k'])
      expect(get.status, get.stderr).toBe(0)
      expect(get.stdout).toContain('Why this exists.')

      // A note-get for the whole file (no --symbol) must not see the symbol-scoped note.
      const getWhole = runCli(['note-get', tmp])
      expect(getWhole.status).toBe(1)
      expect(getWhole.stderr).toContain('No note found')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('note-add rejects an unresolvable --symbol with a did-you-mean hint', () => {
    const tmp = path.join(os.tmpdir(), `tg-note-badsym-${Date.now()}.ts`)
    fs.writeFileSync(tmp, 'export function realNoteFn9k(): number {\n  return 1\n}\n')
    try {
      const r = runCli(['note-add', tmp, '--symbol', 'doesNotExistFn9k', '--content-b64', b64('x')])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("No symbol named 'doesNotExistFn9k'")
      expect(r.stderr).toContain('realNoteFn9k')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('note-add requires either --content-from or --content-b64, and rejects both together', () => {
    const tmp = path.join(os.tmpdir(), `tg-note-flags-${Date.now()}.md`)
    fs.writeFileSync(tmp, '# doc\n', 'utf8')
    try {
      const neither = runCli(['note-add', tmp])
      expect(neither.status).toBe(1)
      expect(neither.stderr).toContain('must provide either --content-from or --content-b64')

      const both = runCli(['note-add', tmp, '--content-from', tmp, '--content-b64', b64('x')])
      expect(both.status).toBe(1)
      expect(both.stderr).toContain('cannot mix --content-from with --content-b64')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('note-add rejects empty content', () => {
    const tmp = path.join(os.tmpdir(), `tg-note-empty-${Date.now()}.md`)
    fs.writeFileSync(tmp, '# doc\n', 'utf8')
    try {
      const r = runCli(['note-add', tmp, '--content-b64', ''])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('note content cannot be empty')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('note-add on a missing file exits 1', () => {
    const missing = path.join(os.tmpdir(), `tg-note-missing-${Date.now()}.md`)
    const r = runCli(['note-add', missing, '--content-b64', b64('x')])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('File not found')
  })

  it('note-add --content-from reads the note body from a source file', () => {
    const tmp = path.join(os.tmpdir(), `tg-note-from-target-${Date.now()}.md`)
    const contentFile = path.join(os.tmpdir(), `tg-note-from-content-${Date.now()}.md`)
    fs.writeFileSync(tmp, '# doc\n', 'utf8')
    fs.writeFileSync(contentFile, 'Note content from a file.', 'utf8')
    try {
      const add = runCli(['note-add', tmp, '--content-from', contentFile])
      expect(add.status, add.stderr).toBe(0)
      const get = runCli(['note-get', tmp])
      expect(get.stdout).toContain('Note content from a file.')
    } finally {
      fs.rmSync(tmp, { force: true })
      fs.rmSync(contentFile, { force: true })
    }
  })

  it('note-get on a file with no note exits 1', () => {
    const tmp = path.join(os.tmpdir(), `tg-note-noneexist-${Date.now()}.md`)
    fs.writeFileSync(tmp, '# doc\n', 'utf8')
    try {
      const r = runCli(['note-get', tmp])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('No note found')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('note-list reports notes and supports --stale-only / --json', () => {
    const tmp1 = path.join(os.tmpdir(), `tg-note-list-a-${Date.now()}.md`)
    const tmp2 = path.join(os.tmpdir(), `tg-note-list-b-${Date.now()}.md`)
    fs.writeFileSync(tmp1, '# a\n', 'utf8')
    fs.writeFileSync(tmp2, '# b\n', 'utf8')
    try {
      runCli(['note-add', tmp1, '--content-b64', b64('note a')])
      runCli(['note-add', tmp2, '--content-b64', b64('note b')])

      const list = runCli(['note-list'])
      expect(list.status, list.stderr).toBe(0)
      expect(list.stdout).toContain(normalizePath(tmp1))
      expect(list.stdout).toContain(normalizePath(tmp2))
      expect(list.stdout).not.toContain('[STALE]')

      const staleOnly = runCli(['note-list', '--stale-only'])
      expect(staleOnly.status, staleOnly.stderr).toBe(0)
      expect(staleOnly.stdout).not.toContain(normalizePath(tmp1))
      expect(staleOnly.stdout).not.toContain(normalizePath(tmp2))

      const listJson = runCli(['note-list', '--json'])
      expect(listJson.status, listJson.stderr).toBe(0)
      const items = JSON.parse(listJson.stdout) as Array<{ filePath: string; stale: boolean }>
      expect(items.some((i) => i.filePath === normalizePath(tmp1))).toBe(true)
    } finally {
      fs.rmSync(tmp1, { force: true })
      fs.rmSync(tmp2, { force: true })
    }
  })

  it('note-add on the same (file, symbol) pair upserts rather than duplicating in note-list', () => {
    const tmp = path.join(os.tmpdir(), `tg-note-upsert-${Date.now()}.md`)
    fs.writeFileSync(tmp, '# doc\n', 'utf8')
    try {
      runCli(['note-add', tmp, '--content-b64', b64('first version')])
      runCli(['note-add', tmp, '--content-b64', b64('second version')])

      const get = runCli(['note-get', tmp])
      expect(get.stdout).toContain('second version')
      expect(get.stdout).not.toContain('first version')

      const list = runCli(['note-list'])
      const occurrences = list.stdout.split('\n').filter((l) => l.includes(normalizePath(tmp))).length
      expect(occurrences).toBe(1)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  // Task requirement: staleness must be discoverable end to end -- add a note attached to a
  // symbol, edit that symbol's signature/body, reindex, and confirm `note-list --stale-only`
  // (and `note-get --json`'s `stale` flag) now report it. Drives the real CLI surface at every
  // step (note-add, index, note-get, note-list) against the real built bundle -- no injected
  // callback standing in for the worker's own reindex path.
  it('editing an indexed symbol and reindexing makes its note discoverable via note-list --stale-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-note-stale-'))
    const file = path.join(dir, 'target.ts')
    try {
      fs.writeFileSync(file, 'export function staleTargetFn9k(): number {\n  return 1\n}\n')

      const add = runCli(['note-add', file, '--symbol', 'staleTargetFn9k', '--content-b64', b64('Why it returns 1.')])
      expect(add.status, add.stderr).toBe(0)

      const beforeGet = runCli(['note-get', file, '--symbol', 'staleTargetFn9k', '--json'])
      expect(beforeGet.status, beforeGet.stderr).toBe(0)
      expect((JSON.parse(beforeGet.stdout) as { stale: boolean }).stale).toBe(false)

      const beforeList = runCli(['note-list', '--stale-only'])
      expect(beforeList.stdout).not.toContain(normalizePath(file))

      // Genuine out-of-band edit to the symbol's body, then a real reindex (the same entry
      // point the worker's dirty-queue drain uses) -- not a synthetic fingerprint mismatch.
      fs.writeFileSync(file, 'export function staleTargetFn9k(): number {\n  return 999\n}\n')
      const idx = runCli(['index', dir, '--walk'])
      expect(idx.status, idx.stderr).toBe(0)

      const afterGet = runCli(['note-get', file, '--symbol', 'staleTargetFn9k', '--json'])
      expect(afterGet.status, afterGet.stderr).toBe(0)
      expect((JSON.parse(afterGet.stdout) as { stale: boolean }).stale).toBe(true)

      const afterList = runCli(['note-list', '--stale-only'])
      expect(afterList.status, afterList.stderr).toBe(0)
      expect(afterList.stdout).toContain('[STALE]')
      expect(afterList.stdout).toContain(normalizePath(file))
      expect(afterList.stdout).toContain('staleTargetFn9k')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

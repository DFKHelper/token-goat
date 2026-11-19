// pack leaves out a file the host's Read deny rules cover and still prints the others.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject } from './helpers/bundle.js'

// HAND-DERIVED: a marker absent from every command's own text, so any occurrence in output is the file's.
const SECRET = 'TOPSECRETPACKWORD'

let root = ''
let project = ''
let env: NodeJS.ProcessEnv = {}

type Run = { status: number | null; stdout: string; stderr: string }
const tg = (args: string[]): Run => bundleTg(project, env, args)
const both = (run: Run): string => `${run.stdout}${run.stderr}`
const tgLines = (run: Run): string[] => run.stderr.split('\n').filter((l) => l.startsWith('[tg]'))

function put(rel: string, body: string): void {
  const file = path.join(project, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-readdeny-pack-'))
  env = { ...env, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_HOOK_SERVER: '0' }
  put('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } }))
  const body = `first line\nthe ${SECRET} line here\nlast line\n`
  for (const dir of ['secrets', 'open']) put(`${dir}/notes.txt`, body)
})

afterAll(() => {
  if (root !== '') fs.rmSync(root, { recursive: true, force: true })
})

describe('pack leaves out a denied file and prints the rest', () => {
  it('a glob matching one denied and one allowed file prints the allowed one only', () => {
    const run = tg(['pack', 'secrets/notes.txt', 'open/notes.txt'])
    expect(run.status, 'pack still succeeds for the allowed file').toBe(0)
    expect(run.stdout, 'the allowed file is packed').toContain('open/notes.txt')
    expect(both(run).split(SECRET).length - 1, 'only the allowed copy of the marker is printed').toBe(1)
    const omitted = tgLines(run).filter((l) => l.includes('omitted:'))
    expect(omitted, 'one omitted line for the denied file').toHaveLength(1)
  })

  it('a pack of only denied files prints no file text', () => {
    const run = tg(['pack', 'secrets/notes.txt'])
    expect(both(run), 'no denied text on any stream').not.toContain(SECRET)
  })
})

/** A nameless `export default` is indexed as `default` on both shipping seams: the worker draining dirty.txt with its real default indexer (no injected callback), and the built CLI's `index` then `symbol`/`read`. */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeDb } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

// HAND-DERIVED: one nameless default per file, written from the ES module grammar and the config and component shapes Vite and Vue document; line numbers counted by hand.
const SOURCES: Record<string, string> = {
  'src/handler.ts': 'import { load } from "./load"\n\nexport default function () {\n  return load()\n}\n',
  'src/widget.js': 'export default class {\n  render() {\n    return 1\n  }\n}\n',
  'src/Panel.vue': '<script>\nexport default function () {\n  return 2\n}\n</script>\n<template><div/></template>\n',
  'src/config.ts': 'export default {\n  port: 1,\n} satisfies { port: number }\n',
  'src/vite.config.js': 'import { defineConfig } from "vite"\n\nexport default defineConfig({\n  base: "/",\n})\n',
  'src/Options.vue': '<script>\nexport default {\n  data() {\n    return { n: 1 }\n  },\n}\n</script>\n<template><div/></template>\n',
  'src/Comp.vue': '<script>\nimport { defineComponent } from "vue"\nexport default defineComponent({\n  name: "Comp",\n})\n</script>\n<template><div/></template>\n',
  'src/reexport.ts': 'const foo = 1\nexport default foo\n',
}

const tempDirs = new Set<string>()

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

function writeRepo(): { repo: string; files: string[] } {
  const repo = tempDir('tg-default-export-repo-')
  const files: string[] = []
  for (const [rel, content] of Object.entries(SOURCES)) {
    const abs = path.join(repo, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    files.push(normalizePath(abs))
  }
  return { repo, files: files.sort() }
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

describe('anonymous default export on the worker default path', () => {
  it('drains each file into a `default` symbol of the right kind', async () => {
    const { files } = writeRepo()
    const dataDir = tempDir('tg-default-export-worker-data-')
    const queue = path.join(dataDir, 'queue', 'dirty.txt')
    fs.mkdirSync(path.dirname(queue), { recursive: true })
    fs.writeFileSync(queue, `${files.join('\n')}\n`)

    expect(drainOnce(dataDir)).toBe(files.length)
    // The drain fires embeddings without waiting; let them finish so cleanup does not race an open DB handle on Windows.
    await pendingEmbeddings()

    const dbPath = path.join(dataDir, 'global.db')
    try {
      const rows = querySymbols({ name: 'default' }, dbPath)
      const byFile = Object.fromEntries(rows.map((r) => [path.basename(r.filePath), r]))
      // reexport.ts only names a value defined above it, so it has no `default` of its own.
      expect(Object.keys(byFile).sort()).toEqual(['Comp.vue', 'Options.vue', 'Panel.vue', 'config.ts', 'handler.ts', 'vite.config.js', 'widget.js'])
      expect(byFile['handler.ts']).toMatchObject({ kind: 'function', lineStart: 3, lineEnd: 5 })
      expect(byFile['widget.js']).toMatchObject({ kind: 'class', lineStart: 1, lineEnd: 5 })
      expect(byFile['Panel.vue']).toMatchObject({ kind: 'sfc_script_function', lineStart: 2, lineEnd: 4 })
      expect(byFile['config.ts']).toMatchObject({ kind: 'variable', lineStart: 1, lineEnd: 3 })
      expect(byFile['vite.config.js']).toMatchObject({ kind: 'variable', lineStart: 3, lineEnd: 5 })
      expect(byFile['Options.vue']).toMatchObject({ kind: 'sfc_script_const', lineStart: 2, lineEnd: 6 })
      expect(byFile['Comp.vue']).toMatchObject({ kind: 'sfc_script_const', lineStart: 3, lineEnd: 5 })
      expect(querySymbols({ name: 'render' }, dbPath)).toMatchObject([{ kind: 'method' }])
    } finally {
      closeDb(dbPath)
    }
  })
})

describe('anonymous default export through the built bundle', () => {
  it('indexes the repo and serves `symbol default` and `read file::default` from dist', () => {
    const { repo } = writeRepo()
    const dataBase = tempDir('tg-default-export-bundle-data-')
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
    const run = (args: string[]) => runBundle(args, { cwd: repo, env: tgIsolatedEnv(dataBase) })

    const indexed = run(['index', repo])
    expect(indexed.status, indexed.stderr).toBe(0)

    const symbol = run(['symbol', 'default'])
    expect(symbol.status, symbol.stderr).toBe(0)
    for (const file of ['handler.ts', 'widget.js', 'Panel.vue', 'config.ts', 'vite.config.js', 'Options.vue', 'Comp.vue']) expect(symbol.stdout, file).toContain(file)
    expect(symbol.stdout).not.toContain('reexport.ts')

    const read = run(['read', 'src/handler.ts::default'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('export default function () {\n  return load()\n}')

    const config = run(['read', 'src/vite.config.js::default'])
    expect(config.status, config.stderr).toBe(0)
    expect(config.stdout).toContain('export default defineConfig({\n  base: "/",\n})')
  }, 60_000)
})

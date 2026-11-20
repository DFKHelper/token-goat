/** The opencode plugin throws to block a tool call; it must do so only for a block whose reason is a string,
 * whatever the hook printed. The plugin's one source of answers is the shared relay block's hookAnswer. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { transformSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

import { OPENCODE_PLUGIN_SCRIPT } from '../../src/bridges/opencode.js'
import { expandShortPath } from '../../src/paths.js'

type Opts = Record<string, unknown>
type Handler = (input: unknown, output: unknown) => Promise<void>
type Plugin = (ctx: { directory: string }) => Promise<Record<string, Handler>>

const SPAWN_SLOT = '__tgOpencodeSpawn'
const slot = globalThis as Record<string, unknown>
const tempDirs: string[] = []
afterEach(() => {
  delete slot[SPAWN_SLOT]
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** Loads the plugin with spawnSync printing `printed` for the baked entry and failing the PATH spawn. */
async function loadPlugin(printed: string): Promise<{ plugin: Plugin; dir: string }> {
  const dir = expandShortPath(mkdtempSync(join(tmpdir(), 'tg-opencode-block-')).replace(/\\/g, '/'))
  tempDirs.push(dir)
  const entry = join(dir, 'entry.cjs')
  writeFileSync(entry, '', 'utf8')
  writeFileSync(join(dir, 'token-goat-entry.json'), JSON.stringify({ entryPath: entry }), 'utf8')
  slot[SPAWN_SLOT] = (command: string, _args: unknown, _options?: Opts) =>
    command === process.execPath ? { status: 0, stdout: printed } : { status: 1, stdout: '' }
  const { code } = transformSync(OPENCODE_PLUGIN_SCRIPT, { loader: 'js', format: 'esm' })
  const importLine = /import \{ spawnSync \} from "node:child_process";?/
  const patched = code.replace(importLine, `const spawnSync = (...a) => globalThis.${SPAWN_SLOT}(...a);`)
  expect(patched, 'the spawnSync import was replaced').not.toBe(code)
  const file = join(dir, 'plugin.mjs')
  writeFileSync(file, patched, 'utf8')
  const mod = (await import(pathToFileURL(file).href)) as { TokenGoatPlugin: Plugin }
  return { plugin: mod.TokenGoatPlugin, dir }
}

async function runPreRead(printed: string): Promise<unknown> {
  const { plugin, dir } = await loadPlugin(printed)
  const hooks = await plugin({ directory: dir })
  try {
    const output = { args: { filePath: join(dir, 'a.txt') } }
    await hooks['tool.execute.before']!({ tool: 'read', sessionID: 's' }, output)
    return undefined
  } catch (error) {
    return error
  }
}

describe('the opencode plugin blocks only on a string reason', () => {
  const blockWith = (reason: unknown): string => JSON.stringify({ decision: 'block', reason })

  const badReasons = [42, { nested: 'object' }, null, ['a']]
  it.each(badReasons)('a block whose reason is %j does not throw', async (reason) => {
    expect(await runPreRead(blockWith(reason)), 'the tool call goes ahead').toBeUndefined()
  })

  it('a clean block throws its reason unchanged', async () => {
    const thrown = await runPreRead(blockWith('already read this file'))
    expect(thrown, 'the block').toBeInstanceOf(Error)
    expect((thrown as Error).message, 'the reason').toBe('already read this file')
  })
})

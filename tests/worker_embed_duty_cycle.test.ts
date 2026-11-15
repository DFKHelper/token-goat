/** Every embed the daemon runs passes the shared duty-cycle budget at the embed chokepoint; a foreground command's embed does not, and the thread default is 1. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultConfig } from '../src/config.js'
import { closeAllDbs } from '../src/db.js'
import { DutyCycleThrottle, type CpuClock } from '../src/duty_cycle.js'
import { DEFAULT_EMBED_THREADS } from '../src/embed_model.js'
import { DEFAULT_DIM, setPipelineFnForTesting } from '../src/embeddings.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import { installDaemonCpuThrottle, makeIndexer, pendingEmbeddings } from '../src/worker.js'

let DIR: string
let dbPath: string
let filePath: string
let prevEmbeddingsEnv: string | undefined
let pipelineCalls: number

function countingPipeline(): unknown {
  return async () =>
    async (text: string) => {
      pipelineCalls += 1
      return { data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700) }
    }
}

/** A clock the test moves by hand, so the budget's state never depends on how busy the host is. */
function manualClock(): CpuClock & { wall: number; cpu: number } {
  const clock = { wall: 0, cpu: 0, wallMs: () => clock.wall, cpuMs: () => clock.cpu }
  return clock
}

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-duty-'))
  dbPath = path.join(DIR, 'global.db')
  filePath = path.join(DIR, 'widget.ts')
  fs.writeFileSync(
    filePath,
    'export function widget(): number {\n  // padding so this chunk clears MIN_CHUNK_CHARS and the fake pipeline actually runs\n  return 1\n}\n',
  )
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  pipelineCalls = 0
  clearModuleCaches()
})

afterEach(() => {
  setPipelineFnForTesting(null)
  clearModuleCaches()
  if (prevEmbeddingsEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  closeAllDbs()
  fs.rmSync(DIR, { recursive: true, force: true })
})

function dispatchDaemonEmbed(): void {
  indexFileSync(filePath, dbPath)
  const sha = fingerprintFile(filePath)
  expect(sha, 'fingerprintFile could not hash the fixture').not.toBeNull()
  makeIndexer(dbPath)(filePath, sha as string)
}

describe('embed thread default', () => {
  it('is 1 in the config and in the partial-config fallback', () => {
    expect(defaultConfig().worker.embed_threads).toBe(1)
    expect(DEFAULT_EMBED_THREADS).toBe(1)
  })
})

describe('daemon embed duty cycle', () => {
  it('rests an embed while the CPU budget is exhausted and runs it once the budget refills', async () => {
    setPipelineFnForTesting(countingPipeline() as never)
    const clock = manualClock()
    installDaemonCpuThrottle(new DutyCycleThrottle(0.7, clock))
    // Ten CPU seconds spent with no wall time earned leaves the balance far below zero.
    clock.cpu += 10_000

    dispatchDaemonEmbed()
    // Longer than the rest between budget checks, so a gate that polled and ran anyway would have run by now.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(pipelineCalls, 'an embed ran while the daemon CPU budget was exhausted').toBe(0)

    clock.wall += 60_000
    await pendingEmbeddings()
    expect(pipelineCalls, 'the embed never ran after the budget refilled').toBeGreaterThan(0)
  })

  it('runs an embed at once while the budget has room', async () => {
    setPipelineFnForTesting(countingPipeline() as never)
    installDaemonCpuThrottle(new DutyCycleThrottle(0.7, manualClock()))

    dispatchDaemonEmbed()
    await pendingEmbeddings()
    expect(pipelineCalls).toBeGreaterThan(0)
  })
})

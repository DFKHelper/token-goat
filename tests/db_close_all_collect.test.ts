/** closeAllDbs discards close errors; closeAllDbsCollect returns them after attempting every handle, and the fixture teardown reports them only after its own remaining steps ran. The failing close is HAND-DERIVED: a handle whose close closes the real connection and then throws, so no file stays locked on Windows. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, closeAllDbsCollect, getDb } from '../src/db.js'
import { releaseFixture } from './helpers/release_fixture.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-close-collect-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function failOnClose(file: string, message: string): ReturnType<typeof getDb> {
  const db = getDb(file)
  const real = db.close.bind(db)
  db.close = () => {
    real()
    throw new Error(message)
  }
  return db
}

describe('closeAllDbsCollect', () => {
  it('returns the close error and still closes the handles after the one that threw', () => {
    failOnClose(path.join(tmp, 'a.db'), 'close failed: a')
    const b = getDb(path.join(tmp, 'b.db'))
    const errors = closeAllDbsCollect()
    expect(errors.map((e) => (e as Error).message)).toEqual(['close failed: a'])
    expect(b.open).toBe(false)
    expect(closeAllDbsCollect()).toEqual([])
  })

  it('closeAllDbs keeps swallowing the error', () => {
    failOnClose(path.join(tmp, 'a.db'), 'close failed: a')
    expect(() => closeAllDbs()).not.toThrow()
    expect(closeAllDbsCollect()).toEqual([])
  })
})

describe('releaseFixture', () => {
  it('reports a close failure in the aggregate after it removed the directory', () => {
    failOnClose(path.join(tmp, 'a.db'), 'close failed: a')
    let thrown: unknown
    try {
      releaseFixture(tmp)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors.map((e: Error) => e.message)).toEqual(['close failed: a'])
    expect(fs.existsSync(tmp)).toBe(false)
  })
})

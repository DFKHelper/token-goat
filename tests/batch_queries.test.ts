import { describe, expect, it } from 'vitest'

import { serveOne } from '../src/batch_serve.js'

describe('multi-op batch queries', () => {
  it('restores request-local process state between queries', async () => {
    const key = `TG_BATCH_QUERY_ISOLATION_${process.pid}`
    const original = process.env[key]
    delete process.env[key]
    const observed: Array<string | undefined> = []

    try {
      const response = await serveOne(
        {
          id: 43,
          operations: [
            { command: 'symbol', args: ['Widget'] },
            { command: 'outline', args: ['src/widget.ts'] },
          ],
        },
        async (argv) => {
          observed.push(process.env[key])
          if (argv[2] === 'symbol') process.env[key] = 'leaked'
        },
        () => undefined,
      )

      expect(response.status).toBe(0)
      expect(observed).toEqual([undefined, undefined])
      expect(process.env[key]).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  })

  it('rejects non-query commands without stopping later queries', async () => {
    const calls: string[][] = []
    const response = await serveOne(
      {
        id: 42,
        operations: [
          { id: 'write', command: 'note', args: ['set', 'key', 'value'] },
          { id: 'lookup', command: 'symbol', args: ['Widget'] },
        ],
      },
      async (argv) => {
        const commandArgs = argv.slice(2)
        calls.push(commandArgs)
        process.stdout.write(commandArgs.join(' '))
      },
      () => undefined,
    )

    expect(calls).toEqual([['symbol', 'Widget']])
    expect(response.status).toBe(2)
    expect(response.results).toEqual([
      { id: 'write', command: null, status: 2, stdout: '', stderr: 'Unsupported batch query command' },
      { id: 'lookup', command: 'symbol', status: 0, stdout: 'symbol Widget', stderr: '' },
    ])
  })

  it('reports malformed operation arguments and continues with later queries', async () => {
    const calls: string[][] = []
    const response = await serveOne(
      {
        id: 44,
        operations: [
          { id: 'bad-args', command: 'symbol', args: ['Widget', 42] as unknown as string[] },
          { command: 'refs', args: ['Widget'] },
        ],
      },
      async (argv) => {
        const commandArgs = argv.slice(2)
        calls.push(commandArgs)
        process.stdout.write(commandArgs.join(' '))
      },
      () => undefined,
    )

    expect(calls).toEqual([['refs', 'Widget']])
    expect(response.status).toBe(2)
    expect(response.results).toEqual([
      { id: 'bad-args', command: 'symbol', status: 2, stdout: '', stderr: 'Batch query operation args must be an array of strings' },
      { id: 1, command: 'refs', status: 0, stdout: 'refs Widget', stderr: '' },
    ])
  })

  it('returns a separate result for each query and continues after a failed query', async () => {
    const calls: string[][] = []
    const request = {
      id: 41,
      operations: [
        { id: 'symbol-result', command: 'symbol', args: ['Widget'] },
        { id: 'outline-result', command: 'outline', args: ['src/widget.ts'] },
        { id: 'second-outline-result', command: 'outline', args: ['src/other.ts'] },
        { id: 'refs-result', command: 'refs', args: ['Widget'] },
      ],
    }

    const response = await serveOne(request, async (argv) => {
      const commandArgs = argv.slice(2)
      calls.push(commandArgs)
      process.stdout.write(commandArgs.join(' '))
      if (commandArgs[0] === 'outline' && commandArgs[1] === 'src/widget.ts') {
        process.stderr.write('outline failed')
        process.exitCode = 4
      }
    }, () => undefined)

    expect(calls).toEqual([
      ['symbol', 'Widget'],
      ['outline', 'src/widget.ts'],
      ['outline', 'src/other.ts'],
      ['refs', 'Widget'],
    ])
    expect(response.status).toBe(4)
    expect(response.results).toEqual([
      { id: 'symbol-result', command: 'symbol', status: 0, stdout: 'symbol Widget', stderr: '' },
      { id: 'outline-result', command: 'outline', status: 4, stdout: 'outline src/widget.ts', stderr: 'outline failed' },
      { id: 'second-outline-result', command: 'outline', status: 0, stdout: 'outline src/other.ts', stderr: '' },
      { id: 'refs-result', command: 'refs', status: 0, stdout: 'refs Widget', stderr: '' },
    ])
  })
})

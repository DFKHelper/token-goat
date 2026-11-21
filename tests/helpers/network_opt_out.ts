import { afterAll, beforeAll } from 'vitest'

import { invalidateConfigCache } from '../../src/config.js'

/** Lets every test in the calling describe reach the network. The suite-wide default (tests/setup/isolate-home.ts) is offline, so a test that really fetches opts out here, and the prior value is restored after the describe. */
export function allowNetworkInDescribe(): void {
  let prior: string | undefined
  beforeAll(() => {
    prior = process.env['TOKEN_GOAT_OFFLINE']
    process.env['TOKEN_GOAT_OFFLINE'] = '0'
    invalidateConfigCache()
  })
  afterAll(() => {
    if (prior === undefined) delete process.env['TOKEN_GOAT_OFFLINE']
    else process.env['TOKEN_GOAT_OFFLINE'] = prior
    invalidateConfigCache()
  })
}

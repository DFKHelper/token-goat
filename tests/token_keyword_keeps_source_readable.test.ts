/** Bare `token` hides credentials, not lexer source. Fixture provenance: HAND-DERIVED. */
import { describe, expect, it } from 'vitest'

import { redactSecrets } from '../src/secret_redact.js'

const GENERIC = '[REDACTED:generic_secret_assignment]'

describe('source that names a variable token stays readable', () => {
  it.each([
    'const token = lexer.next()',
    'token: Token',
    'next_token = parser.advance()',
    'let token = this.scan();',
    'self.token = self.advance(1)',
  ])('leaves %s alone', (input) => {
    expect(redactSecrets(input)).toEqual({ text: input, count: 0 })
  })
})

describe('a credential behind the token keyword stays hidden', () => {
  it.each([
    ['token = "abc123def456ghi789"', `token = "${GENERIC}"`],
    ['token: ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'token: [REDACTED:github_token]'],
    ['auth_token=abc123def456ghi789', `auth_token=${GENERIC}`],
    ['token=abcdefghijkl', `token=${GENERIC}`],
    ['MY_SERVICE_TOKEN=abc123def456', `MY_SERVICE_TOKEN=${GENERIC}`],
    ['token: string', `token: ${GENERIC}`],
  ])('redacts the value of %s', (input, expected) => {
    expect(redactSecrets(input).text).toBe(expected)
  })

  it('a quoted value stays a secret even when it is call-shaped', () => {
    expect(redactSecrets('token = "lexer.next()"').text).toBe(`token = "${GENERIC}"`)
  })
})

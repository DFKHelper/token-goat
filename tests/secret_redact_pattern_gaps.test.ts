/** Redaction of quoted values, more key keywords and more token shapes. Fixture provenance: HAND-DERIVED. */
import { describe, expect, it } from 'vitest'

import { redactSecrets } from '../src/secret_redact.js'

const GENERIC = '[REDACTED:generic_secret_assignment]'

function expectRedacted(input: string, expected: string, count = 1): void {
  const out = redactSecrets(input)
  expect(out.text).toBe(expected)
  expect(out.count).toBe(count)
}

function expectUntouched(input: string): void {
  const out = redactSecrets(input)
  expect(out.text).toBe(input)
  expect(out.count).toBe(0)
}

describe('a quoted value with spaces is redacted whole', () => {
  it('double quotes, bare key', () => {
    expectRedacted('password: "correct horse battery"', `password: "${GENERIC}"`)
  })

  it('double quotes, JSON form, with the next field kept', () => {
    expectRedacted('{"secret": "two words here", "name": "kept"}', `{"secret": "${GENERIC}", "name": "kept"}`)
  })

  it('single quotes', () => {
    expectRedacted("DB_PASSWORD='correct horse battery'", `DB_PASSWORD='${GENERIC}'`)
  })

  it('an escaped quote inside the value does not end it', () => {
    expectRedacted('password: "correct \\"horse\\" battery" tail', `password: "${GENERIC}" tail`)
  })

  it('an unquoted value and a quoted value without spaces are still redacted once each', () => {
    expectRedacted('password=correcthorsebattery', `password=${GENERIC}`)
    expectRedacted('password="correcthorsebattery"', `password="${GENERIC}"`)
  })

  it('redacting the result again changes nothing', () => {
    const once = redactSecrets('password: "correct horse battery"').text
    expect(redactSecrets(once).text).toBe(once)
  })

  it('leaves a short quoted value, a bare word and prose alone', () => {
    expectUntouched('password: "abc"')
    expectUntouched('password: ok')
    expectUntouched('the password is correct horse battery')
    expectUntouched('password "correct horse battery"')
  })

  it('takes linear time on many keywords whose quote is never closed', () => {
    const line = 'password: "x'.repeat(4000)
    const started = performance.now()
    redactSecrets(line)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('the keywords token, auth_token, private_key and credential', () => {
  it.each([
    ['token=abcd1234efgh', `token=${GENERIC}`],
    ['GITHUB_TOKEN: abcd1234efgh', `GITHUB_TOKEN: ${GENERIC}`],
    ['auth_token = Zm9vYmFyYmF6', `auth_token = ${GENERIC}`],
    ['AUTH-TOKEN=Zm9vYmFyYmF6', `AUTH-TOKEN=${GENERIC}`],
    ['private_key=abcd1234efgh', `private_key=${GENERIC}`],
    ['"private_key": "abcd1234efgh"', `"private_key": "${GENERIC}"`],
    ['credential: abcd1234efgh', `credential: ${GENERIC}`],
    ['credentials=abcd1234efgh', `credentials=${GENERIC}`],
  ])('redacts the value of %s', (input, expected) => {
    expectRedacted(input, expected)
  })

  it.each([
    'token_count = 12',
    'max_tokens: 4096',
    'tokens = 1234',
    'token_limit=100000',
    'see credentials.md for the setup',
    'the token is valid for an hour',
    'token: ab',
    'private_keys are listed below',
  ])('leaves %s alone', (input) => {
    expectUntouched(input)
  })
})

describe('the new token shapes', () => {
  const tail = (n: number, alphabet = 'AB12CD34EF56GH78IJ90KL'): string =>
    alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n)
  const lower = (n: number): string => tail(n, 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7')

  it('redacts an ASIA temporary access key id and leaves a near miss', () => {
    const key = 'ASI' + 'A' + tail(16, 'ABCDEFGH12345678')
    expectRedacted(`id ${key} end`, 'id [REDACTED:aws_access_key] end')
    expectUntouched('ASIA' + tail(15, 'ABCDEFGH1234567'))
    expectUntouched('ASIAN markets and ASIA_REGION')
  })

  it('redacts a GitLab token and leaves a short one', () => {
    const token = 'glp' + 'at-' + lower(20)
    expectRedacted(`url token ${token}`, 'url token [REDACTED:gitlab_token]')
    expectUntouched('glp' + 'at-' + lower(19))
  })

  it('redacts a Hugging Face token and leaves a short name and a longer identifier', () => {
    const token = 'h' + 'f_' + lower(34)
    expectRedacted(`HUGGING=${token}`, 'HUGGING=[REDACTED:huggingface_token]')
    expectUntouched('h' + 'f_' + lower(33))
    expectUntouched('hf_model_dir and chf_' + lower(40))
  })

  it('redacts a SendGrid key and leaves a wrong shape', () => {
    const key = 'S' + 'G.' + lower(22) + '.' + lower(43)
    expectRedacted(`mail ${key} sent`, 'mail [REDACTED:sendgrid_api_key] sent')
    expectUntouched('S' + 'G.' + lower(22) + '.' + lower(42))
    expectUntouched('SG.short.value and the SG. prefix')
  })

  it('redacts both spellings of an xoxe token and leaves a short one', () => {
    const body = '1-' + lower(30)
    expectRedacted(`t xoxe-${body} u`, 't [REDACTED:slack_token] u')
    expectRedacted(`t xoxe.xoxp-${body} u`, 't [REDACTED:slack_token] u')
    expectUntouched('xoxe-1 and xoxe.config')
  })
})

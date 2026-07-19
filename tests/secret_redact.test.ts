import { describe, expect, it } from 'vitest'

import { redactSecrets } from '../src/secret_redact.js'

describe('redactSecrets — per-pattern detection', () => {
  it('redacts an AWS access key (AWS documented example key)', () => {
    const { text, count } = redactSecrets('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')
    expect(count).toBe(1)
    expect(text).toBe('AWS_ACCESS_KEY_ID=[REDACTED:aws_access_key]')
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('redacts a GitHub personal access token', () => {
    const fake = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const { text, count } = redactSecrets(`export GITHUB_TOKEN=${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('export GITHUB_TOKEN=[REDACTED:github_token]')
    expect(text).not.toContain(fake)
  })

  it('redacts an OpenAI-style API key', () => {
    const fake = 'sk-' + 'abcdefghijklmnopqrstuvwxyz012345'
    const { text, count } = redactSecrets(`OPENAI_API_KEY="${fake}"`)
    expect(count).toBe(1)
    expect(text).toBe('OPENAI_API_KEY="[REDACTED:openai_api_key]"')
    expect(text).not.toContain(fake)
  })

  it('redacts a modern OpenAI project key (sk-proj-, which contains - and _ after the prefix)', () => {
    // Regression: the generic openai pattern requires >=20 chars of [A-Za-z0-9] immediately
    // after "sk-", so "sk-proj-..." (4 alnum then a hyphen) never matched and the dominant
    // post-2024 OpenAI key format was written to the cache in plaintext.
    const fake = 'sk-proj-' + 'Ab1_Cd2-Ef3_Gh4-Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3'
    const { text, count } = redactSecrets(`OPENAI_API_KEY=${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('OPENAI_API_KEY=[REDACTED:openai_project_key]')
    expect(text).not.toContain(fake)
  })

  it('redacts a GitHub fine-grained personal access token (github_pat_ prefix)', () => {
    // Regression: the gh[oprsu]_ pattern only covers classic tokens; fine-grained PATs use the
    // distinct "github_pat_" prefix and were written to the cache in plaintext.
    const fake = 'github_pat_' + '11ABCDEFG0abcdefghijklmn_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789abcdefghijklmnopqr'
    const { text, count } = redactSecrets(`export GITHUB_TOKEN=${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('export GITHUB_TOKEN=[REDACTED:github_token]')
    expect(text).not.toContain(fake)
  })

  it('redacts an Anthropic API key (and does not double-classify it as an OpenAI key)', () => {
    const fake = 'sk-ant-api03-' + 'a'.repeat(40)
    const { text, count } = redactSecrets(`ANTHROPIC_API_KEY=${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('ANTHROPIC_API_KEY=[REDACTED:anthropic_api_key]')
    expect(text).not.toContain(fake)
  })

  it('redacts a Slack token', () => {
    const fake = 'xoxb-' + '123456789012-123456789012-abcdefghijklmnopqrstuvwx'
    const { text, count } = redactSecrets(`SLACK_TOKEN=${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('SLACK_TOKEN=[REDACTED:slack_token]')
    expect(text).not.toContain(fake)
  })

  it('redacts a PEM private key block, including the base64 key body itself', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAvery-secret-key-material-here\nmore-key-bytes-on-a-second-line\n-----END RSA PRIVATE KEY-----'
    const { text, count } = redactSecrets(pem)
    expect(count).toBe(1)
    expect(text).toBe('[REDACTED:private_key_block]')
    expect(text).not.toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(text).not.toContain('MIIEowIBAAKCAQEAvery-secret-key-material-here')
    expect(text).not.toContain('more-key-bytes-on-a-second-line')
  })

  it('redacts a bare (non-RSA/EC/OPENSSH) PEM private key block, body included', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC-secret-body\n-----END PRIVATE KEY-----'
    const { text, count } = redactSecrets(pem)
    expect(count).toBe(1)
    expect(text).toBe('[REDACTED:private_key_block]')
    expect(text).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC-secret-body')
  })

  it('redacts each block independently when multiple private keys appear in one blob', () => {
    const pem1 = '-----BEGIN RSA PRIVATE KEY-----\nfirst-key-body\n-----END RSA PRIVATE KEY-----'
    const pem2 = '-----BEGIN EC PRIVATE KEY-----\nsecond-key-body\n-----END EC PRIVATE KEY-----'
    const { text, count } = redactSecrets(`${pem1}\n\n${pem2}`)
    expect(count).toBe(2)
    expect(text).not.toContain('first-key-body')
    expect(text).not.toContain('second-key-body')
  })
})

describe('redactSecrets — no false positives on ordinary content', () => {
  it('leaves plain text with no secrets byte-for-byte unmodified', () => {
    const input = 'Build succeeded. 42 files changed, 128 insertions(+), 3 deletions(-).'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves a UUID unmodified', () => {
    const input = 'request id: 550e8400-e29b-41d4-a716-446655440000'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves a git SHA unmodified', () => {
    const input = 'commit b8bf055ba1e2c3d4f5061728394a5b6c7d8e9f01 refactor(cache): dedupe'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves ordinary base64-encoded (non-secret) content unmodified', () => {
    const input = 'SGVsbG8gd29ybGQsIHRoaXMgaXMgb3JkaW5hcnkgYmFzZTY0IGVuY29kZWQgdGV4dCB3aXRoIG5vIHNlY3JldHMu'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves a JWT unmodified (no pattern in this set targets JWTs)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const { text, count } = redactSecrets(jwt)
    expect(count).toBe(0)
    expect(text).toBe(jwt)
  })

  it('leaves normal JSON tool output unmodified', () => {
    const input = JSON.stringify({
      stdout: 'npm install completed',
      exitCode: 0,
      duration_ms: 4213,
      cwd: 'C:/Projects/token-goat',
    })
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })
})

describe('redactSecrets — mixed and multi-secret content', () => {
  it('redacts only the secret portion of mixed secret + non-secret content', () => {
    const fakeKey = 'AKIAIOSFODNN7EXAMPLE'
    const input = `Deploy log:\nBuild ok.\nAWS_ACCESS_KEY_ID=${fakeKey}\nDeployed to prod.`
    const { text, count } = redactSecrets(input)
    expect(count).toBe(1)
    expect(text).toBe(`Deploy log:\nBuild ok.\nAWS_ACCESS_KEY_ID=[REDACTED:aws_access_key]\nDeployed to prod.`)
    expect(text).toContain('Deploy log:')
    expect(text).toContain('Deployed to prod.')
  })

  it('redacts every secret when multiple distinct secrets appear in one blob', () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE'
    const ghToken = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const input = `AWS=${awsKey}\nGITHUB=${ghToken}`
    const { text, count } = redactSecrets(input)
    expect(count).toBe(2)
    expect(text).toBe('AWS=[REDACTED:aws_access_key]\nGITHUB=[REDACTED:github_token]')
  })

  it('redacts repeated occurrences of the same secret pattern', () => {
    const awsKey1 = 'AKIAIOSFODNN7EXAMPLE'
    const awsKey2 = 'AKIAI44QH8DHBEXAMPLE'
    const input = `first=${awsKey1} second=${awsKey2}`
    const { text, count } = redactSecrets(input)
    expect(count).toBe(2)
    expect(text).toBe('first=[REDACTED:aws_access_key] second=[REDACTED:aws_access_key]')
  })
})

describe('redactSecrets — performance', () => {
  it('completes quickly over a large blob near the realistic cache size cap', () => {
    // bash_compress.cache_max_bytes_per_output defaults to 50 MiB (the largest
    // per-item cap of any storeBlob() caller); mcp_cache's MCP_MAX_CACHE_BYTES
    // is a much smaller 2 MiB. Exercise a few MiB of realistic log-shaped text
    // with a handful of secrets sprinkled in, well above MCP's cap and a
    // meaningful fraction of bash's, without making the test itself slow.
    const line = 'INFO 2026-07-18T00:00:00Z request completed in 42ms status=200\n'
    const chunks: string[] = []
    let size = 0
    const targetBytes = 5 * 1024 * 1024
    while (size < targetBytes) {
      chunks.push(line)
      size += line.length
    }
    chunks.splice(1000, 0, 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n')
    chunks.splice(2000, 0, 'GITHUB_TOKEN=ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8\n')
    const input = chunks.join('')

    const start = Date.now()
    const { count } = redactSecrets(input)
    const elapsedMs = Date.now() - start

    expect(count).toBe(2)
    expect(elapsedMs).toBeLessThan(2000) // soft bound — linear-scan patterns over ~5 MiB should be near-instant
  })
})

import { describe, expect, it } from 'vitest'

import { redactSecrets } from '../src/secret_redact.js'

describe('redactSecrets — per-pattern detection', () => {
  it('redacts an AWS access key (AWS documented example key)', () => {
    const { text, count } = redactSecrets(`AWS_ACCESS_KEY_ID=${'AKIA' + 'IOSFODNN7EXAMPLE'}`)
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
    const pem = '-----' + 'BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAvery-secret-key-material-here\nmore-key-bytes-on-a-second-line\n-----' + 'END RSA PRIVATE KEY-----'
    const { text, count } = redactSecrets(pem)
    expect(count).toBe(1)
    expect(text).toBe('[REDACTED:private_key_block]')
    expect(text).not.toContain('-----' + 'BEGIN RSA PRIVATE KEY-----')
    expect(text).not.toContain('MIIEowIBAAKCAQEAvery-secret-key-material-here')
    expect(text).not.toContain('more-key-bytes-on-a-second-line')
  })

  it('redacts a bare (non-RSA/EC/OPENSSH) PEM private key block, body included', () => {
    const pem = '-----' + 'BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC-secret-body\n-----' + 'END PRIVATE KEY-----'
    const { text, count } = redactSecrets(pem)
    expect(count).toBe(1)
    expect(text).toBe('[REDACTED:private_key_block]')
    expect(text).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC-secret-body')
  })

  it.each([
    ['ENCRYPTED PRIVATE KEY', 'openssl genpkey -aes256 / ssh-keygen -m PKCS8 with a passphrase'],
    ['DSA PRIVATE KEY', 'legacy openssl dsa'],
  ])('redacts a %s block, body included (%s)', (label) => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC-secret-body'
    const pem = `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`
    const { text, count } = redactSecrets(pem)
    expect(count).toBe(1)
    expect(text).toBe('[REDACTED:private_key_block]')
    expect(text).not.toContain(body)
    expect(text).not.toContain(label)
  })

  it('redacts a PGP private key block, whose header carries a trailing BLOCK word', () => {
    const body = 'lQOYBGX1secret-gpg-key-material-here'
    const pem = `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\n${body}\n-----END PGP PRIVATE KEY BLOCK-----`.replace('BEGIN', 'BEGIN').replace('PRIVATE', 'PRIVATE')
    const { text, count } = redactSecrets(pem)
    expect(count).toBe(1)
    expect(text).toBe('[REDACTED:private_key_block]')
    expect(text).not.toContain(body)
  })

  it('redacts a Slack app-level (xapp-) token, not just the xox* family', () => {
    const fake = 'xapp-1-A01234567-1234567890123-abcdef0123456789abcdef0123456789'
    const { text, count } = redactSecrets(`SLACK_APP_TOKEN=${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('SLACK_APP_TOKEN=[REDACTED:slack_token]')
    expect(text).not.toContain(fake)
  })

  it('leaves an armored certificate or public key alone: only PRIVATE KEY blocks are redacted', () => {
    const cert = '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl-ordinary-public-cert\n-----END CERTIFICATE-----'
    const pub = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq-ordinary-public-key\n-----END PUBLIC KEY-----'
    const { text, count } = redactSecrets(`${cert}\n\n${pub}`)
    expect(count).toBe(0)
    expect(text).toBe(`${cert}\n\n${pub}`)
  })

  it.each(['xapp-container', 'xapp-config', 'xapp-1', 'xapp-feature-flag-enabled'])(
    'leaves the ordinary identifier %s alone: xapp- alone is not a Slack token',
    (ident) => {
      const line = `className={styles["${ident}"]}`
      const { text, count } = redactSecrets(line)
      expect(count).toBe(0)
      expect(text).toBe(line)
    },
  )

  it.each([
    ['-----BEGIN PGP PRIVATE KEY-----', '-----END PGP PRIVATE KEY BLOCK-----'],
    ['-----BEGIN RSA PRIVATE KEY-----', '-----END EC PRIVATE KEY-----'],
    ['-----BEGIN PRIVATE KEY-----', '-----END ENCRYPTED PRIVATE KEY-----'],
  ])('does not pair %s with the mismatched %s', (begin, end) => {
    const between = 'ORDINARY UNRELATED TEXT THAT MUST SURVIVE'
    const { text, count } = redactSecrets(`${begin}\n${between}\n${end}`)
    expect(count).toBe(0)
    expect(text).toContain(between)
  })

  it('stays linear on a blob of unterminated BEGIN markers', () => {
    const marker = '-----BEGIN RSA PRIVATE KEY-----\nx\n'
    const time = (n: number): number => {
      const blob = marker.repeat(n)
      const start = performance.now()
      redactSecrets(blob)
      return performance.now() - start
    }
    time(4000)
    const small = Math.max(time(4000), 1)
    const large = time(16000)
    // Four times the input. Linear scaling lands near 4x; the quadratic shape this guards
    // against was ~16x. A generous ceiling keeps the test from flaking on a loaded machine
    // while still failing hard if the negative lookahead bounding the body is ever removed.
    expect(large / small).toBeLessThan(25)
  })

  it('redacts each block independently when multiple private keys appear in one blob', () => {
    const pem1 = '-----BEGIN RSA PRIVATE KEY-----\nfirst-key-body\n-----END RSA PRIVATE KEY-----'
    const pem2 = '-----BEGIN EC PRIVATE KEY-----\nsecond-key-body\n-----END EC PRIVATE KEY-----'
    const { text, count } = redactSecrets(`${pem1}\n\n${pem2}`)
    expect(count).toBe(2)
    expect(text).not.toContain('first-key-body')
    expect(text).not.toContain('second-key-body')
  })

  it('redacts an Authorization: Bearer header value, keeping the header name and scheme intact', () => {
    const fake = 'abcDEF123ghiJKL456mnoPQR789'
    const { text, count } = redactSecrets(`Authorization: ` + `Bearer ` + `${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('Authorization: Bearer [REDACTED:auth_bearer_token]')
    expect(text).not.toContain(fake)
  })

  it('redacts an Authorization: Basic header value (base64-encoded credentials), keeping the header name and scheme intact', () => {
    const fake = 'dXNlcm5hbWU6cGFzc3dvcmQ=' // base64("username:pass"), an illustrative fixture pair
    const { text, count } = redactSecrets(`Authorization: Basic ${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('Authorization: Basic [REDACTED:auth_basic_token]')
    expect(text).not.toContain(fake)
  })

  it('redacts a JWT (three base64url segments anchored on the eyJ header prefix)', () => {
    // Regression: before this pattern existed, a JWT was deliberately left unmodified (see the
    // "leaves a JWT unmodified" case below, which this task's brief changes on purpose).
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const { text, count } = redactSecrets(`Authorization: ${jwt}`)
    expect(count).toBe(1)
    expect(text).toBe('Authorization: [REDACTED:jwt]')
    expect(text).not.toContain(jwt)
  })

  // A `=` in the header or payload segment used to defeat the pattern outright, so the token was
  // not partly redacted but printed whole. Base64url as the JWT spec defines it has no padding,
  // but a producer using a plain base64 encoder emits it, and a credential that leaks in full is
  // the same leak whichever encoder made it. The unpadded form is covered by the case above; these
  // are the three positions padding can appear in.
  it.each([
    ['padded payload', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0=.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
    ['padded header', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ==.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
    ['padded signature', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk='],
  ])('redacts a JWT whose segments carry base64 padding (%s)', (_label, jwt) => {
    const { text, count } = redactSecrets(`Authorization: ${jwt}`)

    expect(count).toBe(1)
    // The token body must not survive anywhere in the output, whatever the placeholder looks like.
    expect(text).not.toContain('eyJzdWIiOiIxMjM0NTY3ODkw')
    expect(text).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    expect(text).toContain('[REDACTED:jwt]')
  })

  it('redacts an npm token (npm_ + 36 chars)', () => {
    const fake = 'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const { text, count } = redactSecrets(`//registry.npmjs.org/:_authToken=${fake}`)
    expect(count).toBe(1)
    expect(text).toBe(`//registry.npmjs.org/:_authToken=[REDACTED:npm_token]`)
    expect(text).not.toContain(fake)
  })

  it('redacts a Stripe live secret key', () => {
    const fake = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'
    const { text, count } = redactSecrets(`STRIPE_SECRET_KEY=${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('STRIPE_SECRET_KEY=[REDACTED:stripe_key]')
    expect(text).not.toContain(fake)
  })

  it('redacts a Stripe test secret key and a Stripe restricted key', () => {
    const testKey = 'sk_test_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'
    const restrictedKey = 'rk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'
    const { text, count } = redactSecrets(`TEST=${testKey}\nRESTRICTED=${restrictedKey}`)
    expect(count).toBe(2)
    expect(text).toBe('TEST=[REDACTED:stripe_key]\nRESTRICTED=[REDACTED:stripe_key]')
  })

  it('redacts a Google API key (AIza + 35 chars)', () => {
    const fake = 'AIza' + 'SyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567'
    const { text, count } = redactSecrets(`GOOGLE_API_KEY=${fake}`)
    expect(count).toBe(1)
    expect(text).toBe('GOOGLE_API_KEY=[REDACTED:google_api_key]')
    expect(text).not.toContain(fake)
  })

  it('redacts a generic password= assignment in an env-line shape, keeping the key name intact', () => {
    const { text, count } = redactSecrets('DB_PASSWORD=hunter2FakeValue')
    expect(count).toBe(1)
    expect(text).toBe('DB_PASSWORD=[REDACTED:generic_secret_assignment]')
  })

  it('redacts a generic api_key= assignment in a query-string shape without eating the rest of the URL (regression guard for the exact failure mode this pattern must avoid)', () => {
    const { text, count } = redactSecrets('https://api.example.com/v1/data?api_key=ZZZ9x8y7w6v5u4t3s2r1q0&format=json')
    expect(count).toBe(1)
    expect(text).toBe('https://api.example.com/v1/data?api_key=[REDACTED:generic_secret_assignment]&format=json')
    expect(text).toContain('&format=json')
  })

  it('redacts a generic secret= assignment but stops at the next word, not the rest of the line', () => {
    const { text, count } = redactSecrets('secret=abc123Fake the rest of this sentence continues normally')
    expect(count).toBe(1)
    expect(text).toBe('secret=[REDACTED:generic_secret_assignment] the rest of this sentence continues normally')
    expect(text).toContain('the rest of this sentence continues normally')
  })

  it('redacts a generic api_key= assignment longer than 64 characters completely, not just its first 64 chars (regression: a 64-char upper bound on the value class left the tail of any longer secret unredacted in plain text)', () => {
    const longSecret = 'A'.repeat(91)
    const { text, count } = redactSecrets(`api_key=${longSecret} end`)
    expect(count).toBe(1)
    expect(text).toBe('api_key=[REDACTED:generic_secret_assignment] end')
    expect(text).not.toContain(longSecret.slice(64))
    expect(text).not.toContain('A'.repeat(27))
  })

  // The keyword had to sit immediately before the separator, so any name that merely contains
  // it -- the standard spelling of an AWS secret access key among them -- leaked in full.
  it.each([
    ['AWS_SECRET_ACCESS_KEY=', 'wJalrXUtnFEMIKfakeDENGbPxRfiCYEXAMPLEKEY'],
    ['SECRET_KEY=', 'django-insecure-9f8s7df98s7df98sdf'],
    ['DB_PASSWORD_HASH=', 'abc123def456fake'],
    ['CLIENT_SECRET_VALUE=', 'abcdef123456fake'],
  ])('redacts a generic %s assignment where the keyword is a prefix of a longer key name', (key, value) => {
    const { text, count } = redactSecrets(`${key}${value}`)
    expect(count).toBe(1)
    expect(text).toBe(`${key}[REDACTED:generic_secret_assignment]`)
    expect(text).not.toContain(value)
  })

  // apikey/api-key are the same key spelled without the underscore, and were uncovered.
  it.each([
    ['apikey=', 'abcdef123456fake'],
    ['api-key=', 'abcdef123456fake'],
    ['APIKEY=', 'abcdef123456fake'],
  ])('redacts a generic %s assignment spelled without an underscore', (key, value) => {
    const { text, count } = redactSecrets(`${key}${value}`)
    expect(count).toBe(1)
    expect(text).toBe(`${key}[REDACTED:generic_secret_assignment]`)
  })

  it('still leaves prose that merely contains a keyword alone, since the keyword must reach a separator', () => {
    const prose = 'The secret to good code is clarity, and the password policy is documented elsewhere.'
    const { text, count } = redactSecrets(prose)
    expect(count).toBe(0)
    expect(text).toBe(prose)
  })

  it('does not re-match its own placeholder when the key name has a keyword prefix', () => {
    const { text, count } = redactSecrets('SECRET_KEY=abcdef123456fake')
    expect(count).toBe(1)
    expect(text).toBe('SECRET_KEY=[REDACTED:generic_secret_assignment]')
  })

  it('does not exhibit catastrophic backtracking on adversarial input for the generic assignment pattern (ReDoS safety after removing its upper length bound)', () => {
    const adversarial = `api_key=${'a'.repeat(200000)}!`
    const start = Date.now()
    const { count } = redactSecrets(adversarial)
    expect(Date.now() - start).toBeLessThan(2000)
    expect(count).toBe(1)
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

  // Behavior change from this task's brief: a JWT is now redacted by the new 'jwt' pattern
  // above; this case was updated from its previous "leaves a JWT unmodified" assertion to
  // instead confirm a JWT-shaped-but-too-short string (only two segments, and each segment
  // under the 10-char floor) is correctly left alone as a near-miss.
  it('leaves a JWT-shaped string with too few segments or segments below the length floor unmodified', () => {
    const notQuiteAJwt = 'eyJab.cd'
    const { text, count } = redactSecrets(notQuiteAJwt)
    expect(count).toBe(0)
    expect(text).toBe(notQuiteAJwt)
  })

  it('leaves an Authorization: Bearer header with a too-short value unmodified (below the 10-char confidence floor)', () => {
    const input = 'Authorization: Bearer abc'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves an npm-prefixed identifier that is not a real token unmodified (npm config var name, underscore breaks the run before 36 chars)', () => {
    const input = 'npm_config_registry=https://registry.npmjs.org/'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves a near-miss Stripe-shaped string unmodified (hyphen instead of the required underscore after the prefix)', () => {
    const input = 'reference=sk_test-not-a-real-stripe-key-shape'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves a near-miss Google-API-key-shaped string unmodified (too short after the AIza prefix)', () => {
    const input = 'AIzaShortAndNotReal'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves plain mentions of the word "password" with no assignment unmodified', () => {
    const input = 'Please enter your password below and click submit.'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
  })

  it('leaves a word that merely contains "secret" as a substring unmodified (no assignment operator immediately follows it)', () => {
    const input = 'secretary@example.com sent the quarterly report.'
    const { text, count } = redactSecrets(input)
    expect(count).toBe(0)
    expect(text).toBe(input)
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

// Regression: a quoted secret was never redacted. The value class deliberately excludes quote
// characters so a match cannot run past the closing quote, but the lookbehind ended at the
// separator, so an opening quote stopped the match before it began -- and the closing quote of a
// quoted key name blocked it from the other side. `API_KEY=<value>` was caught while
// `API_KEY="<value>"` passed through in full, and every JSON body passed through in full.
// Quoting is the ordinary way secrets are written: .env, JSON, YAML and TOML all quote by
// default, so the common shape leaked while the uncommon one was covered. Nothing in the 47
// tests already here used a quote anywhere, which is exactly why it survived.
describe('redactSecrets — quoted values', () => {
  const value = 'abcd1234efgh5678ijkl'

  it.each([
    ['double-quoted env', `API_KEY="${value}"`],
    ['single-quoted env', `API_KEY='${value}'`],
    ['json key and value', `{"api_key": "${value}"}`],
    ['json with no spaces', `{"password":"${value}"}`],
    ['yaml', `password: "${value}"`],
    ['toml with spaces around =', `secret = "${value}"`],
  ])('redacts a %s', (_label, input) => {
    const { text, count } = redactSecrets(input)

    expect(count).toBe(1)
    expect(text, 'the secret itself must not survive anywhere in the output').not.toContain(value)
    expect(text).toContain('[REDACTED:generic_secret_assignment]')
  })

  // The quotes themselves stay: they are part of the surrounding document, and the value class
  // still excludes them, so the match cannot swallow the rest of the line.
  it('leaves the quotes and the key name readable', () => {
    expect(redactSecrets(`API_KEY="${value}"`).text).toBe('API_KEY="[REDACTED:generic_secret_assignment]"')
  })

  it('redacts a bearer token carried in a JSON body, not just a raw header line', () => {
    const token = 'abc123def456ghi789'

    const { text, count } = redactSecrets(`{"Authorization": "Bearer ${token}"}`)

    expect(count).toBe(1)
    expect(text).not.toContain(token)
    expect(text).toBe('{"Authorization": "Bearer [REDACTED:auth_bearer_token]"}')
  })

  it('redacts a basic credential carried the same way', () => {
    const { text } = redactSecrets('{"Authorization": "Basic dXNlcjpwYXNz"}')

    expect(text).not.toContain('dXNlcjpwYXNz')
  })

  // The quote allowance must not turn prose or an empty value into a false positive, and it must
  // not let the pattern re-match its own placeholder on a second pass over already-redacted text.
  it.each([
    ['prose that only mentions the word', 'the password field is required'],
    ['an empty quoted value', 'password: ""'],
    ['an empty query parameter', 'https://example.test/a?password=&next=/home'],
    ['text that was already redacted', 'API_KEY=[REDACTED:generic_secret_assignment]'],
  ])('leaves %s alone', (_label, input) => {
    expect(redactSecrets(input)).toEqual({ text: input, count: 0 })
  })
})

// A backslash is the one character the value class cannot simply accept or reject. Accepting it
// stopped the match at the quote it was escaping, so `{"API_KEY":"abcd\\\"efghijkl"}` redacted
// `abcd\` and left `efghijkl` sitting in plain text -- a partial redaction, which reads as
// handled and is not. Rejecting it outright would have stopped the match at the backslash instead.
// The escape branch consumes the pair, and excludes a newline so a trailing backslash cannot pull
// the following line into the match.
describe('redactSecrets — backslashes in a value', () => {
  const BS = String.fromCharCode(92)

  it('consumes an escaped quote instead of stopping at it', () => {
    const { text } = redactSecrets(`{"API_KEY":"abcd${BS}"efghijkl"}`)

    expect(text, 'the tail after the escape must not survive').not.toContain('efghijkl')
    expect(text).toBe('{"API_KEY":"[REDACTED:generic_secret_assignment]"}')
  })

  it('does not let a trailing backslash swallow the next line', () => {
    const { text } = redactSecrets(`API_KEY=abcdefgh${BS}
NEXT_VAR=publicvalue`)

    expect(text).toContain('NEXT_VAR=publicvalue')
  })
})

// The value class excludes whitespace, '&', ';' and '#' so a match cannot run into the next
// key=value pair or a trailing comment. It did not exclude ',' or braces, so the separators used
// by an inline env list and by unquoted JSON were swallowed along with the secret: redacting
// `API_KEY=<value>,OTHER=public` also deleted `,OTHER=public`. Over-redaction is the safe
// direction for the secret itself and the wrong direction for the structure around it.
describe('redactSecrets — structure around the value', () => {
  it.each([
    ['a following comma-separated pair', 'API_KEY=abcd1234efgh5678ijkl,OTHER=public', ',OTHER=public'],
    ['a closing brace', 'API_KEY=abcd1234efgh5678ijkl}', '}'],
  ])('leaves %s intact', (_label, input, survivor) => {
    const { text } = redactSecrets(input)

    expect(text).toContain('[REDACTED:generic_secret_assignment]')
    expect(text.endsWith(survivor), `expected ${JSON.stringify(text)} to keep ${survivor}`).toBe(true)
  })
})

// OAuth token names are not spelled with any of the original four keywords, so an access or
// refresh token -- the credential most often present in a logged token-endpoint response -- was
// cached verbatim.
describe('redactSecrets — oauth token names', () => {
  it.each([
    ['access_token', '{"access_token":"abcdefghijklmnop"}'],
    ['refresh_token', 'refresh_token=abcdefghijklmnop'],
    ['id_token', 'id_token: "abcdefghijklmnop"'],
  ])('redacts %s', (_label, input) => {
    const { text, count } = redactSecrets(input)

    expect(count).toBe(1)
    expect(text).not.toContain('abcdefghijklmnop')
  })
})

// A connection url carries its credential in the authority section, where there is no `key=value`
// separator for the generic pattern to anchor on. A DATABASE_URL echoed by a failing migration
// went through untouched.
describe('redactSecrets — credentials in a url', () => {
  it.each([
    ['postgres', 'postgres://user:supersecret@db.example', 'supersecret'],
    ['mysql with a port and path', 'mysql://root:hunter2hunter2@127.0.0.1:3306/app', 'hunter2hunter2'],
  ])('redacts the password in a %s url', (_label, input, secret) => {
    const { text, count } = redactSecrets(input)

    expect(count).toBe(1)
    expect(text).not.toContain(secret)
    expect(text).toContain('[REDACTED:url_credentials]')
  })

  // The '@' is what separates a credential from a port. Without requiring it, every `host:port`
  // in every url in the output would be redacted as a credential.
  it.each([
    ['a url with a port but no credentials', 'http://example.com:8080/path'],
    ['a plain url', 'https://example.com/a/b'],
  ])('leaves %s alone', (_label, input) => {
    expect(redactSecrets(input)).toEqual({ text: input, count: 0 })
  })
})

// `& ; # , :` are separator characters and they are also ordinary credential characters. Rejecting
// them outright treated every occurrence as a separator, so a value containing one was cut at it
// and the tail printed in full -- or, when the run before it was under the four-character floor,
// the whole value went unmatched and `count` reported 0. Both write a live credential to disk via
// storeBlob; the first also reads as handled, which this module's header calls the worse outcome.
describe('redactSecrets — separator characters inside a value', () => {
  it.each([
    ['a colon, where the leading run is under the length floor', 'DB_PASSWORD=Aa1:xyz123secret', 'Aa1:xyz123secret'],
    ['a hash', 'password=p@ss#word123', 'p@ss#word123'],
    ['ampersands', 'ADMIN_PASSWORD=corr&horse&battery', 'corr&horse&battery'],
    ['a semicolon', 'SECRET_KEY=abcd;efghijkl', 'abcd;efghijkl'],
    ['commas inside a quoted value', '{"api_key": "abc,def,ghi123"}', 'abc,def,ghi123'],
  ])('redacts a value containing %s in full', (_label, input, secret) => {
    const { text, count } = redactSecrets(input)

    expect(count, `expected ${JSON.stringify(input)} to be redacted at all`).toBe(1)
    expect(text, 'no part of the value may survive').not.toContain(secret)
    for (const fragment of secret.split(/[&;#,:]/)) {
      if (fragment.length > 0) {
        expect(text, `the fragment ${JSON.stringify(fragment)} was left in plain text`).not.toContain(fragment)
      }
    }
  })

  // The other half of the same rule: a separator that really is separating one field from the
  // next still ends the value, which is what keeps the structure around a secret readable.
  it.each([
    ['a comma-separated pair', 'API_KEY=abcd1234efgh5678ijkl,OTHER=public', ',OTHER=public'],
    ['a cookie-style semicolon', 'Cookie: api_key=abcd1234efgh; other=1', '; other=1'],
    ['a query-string ampersand', 'https://x.test/a?api_key=abcd1234efgh&other=1', '&other=1'],
  ])('still stops at %s', (_label, input, survivor) => {
    const { text, count } = redactSecrets(input)

    expect(count).toBe(1)
    expect(text).toContain('[REDACTED:generic_secret_assignment]')
    expect(text, `expected ${JSON.stringify(text)} to keep ${survivor}`).toContain(survivor)
  })
})

// The lookbehind allows up to eight spaces at every gap except the one immediately before the
// token, which demanded exactly one -- so a header aligned with two spaces went straight through.
// `token` is the other scheme spelling in wide use (curl and gh pass it for GitHub); a value
// behind it carries the same authority as one behind `Bearer` and was cached verbatim.
describe('redactSecrets — Authorization header spellings', () => {
  it.each([
    ['two spaces after the scheme', 'Authorization: Bearer  abcdefghijklmnop'],
    ['the token scheme', 'Authorization: token abcdefghijklmnop'],
    ['the Token scheme capitalised', 'Authorization: Token abcdefghijklmnop'],
  ])('redacts a header written with %s', (_label, input) => {
    const { text, count } = redactSecrets(input)

    expect(count).toBe(1)
    expect(text).not.toContain('abcdefghijklmnop')
    expect(text).toContain('[REDACTED:auth_bearer_token]')
  })

  it('leaves the header name and scheme readable, so a request log still makes sense', () => {
    const { text } = redactSecrets('Authorization: token abcdefghijklmnop')

    expect(text).toBe('Authorization: token [REDACTED:auth_bearer_token]')
  })
})

// An Azure storage account connection string carries a full read/write key to the account in its
// AccountKey field. Nothing in generic_secret_assignment's keyword list (password|passwd|secret|
// api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token) matches "AccountKey", so this key
// went through storeBlob() and every live rewrite path in full plaintext until azure_storage_key
// was added.
describe('redactSecrets — Azure storage account keys', () => {
  // A real-shaped, but not a real, key: 88 base64 characters (64 bytes) with trailing `==`
  // padding, matching the length Azure actually issues.
  const AZURE_KEY = 'ZGVmaW5pdGVseW5vdGFyZWFsa2V5ZGVmaW5pdGVseW5vdGFyZWFsa2V5ZGVmaW5pdGVseW5vdGFyZWFsa2V5PT=='

  it('redacts the AccountKey field in a full Azure storage connection string, leaving every other field readable', () => {
    const input = `DefaultEndpointsProtocol=https;AccountName=goat;AccountKey=${AZURE_KEY};EndpointSuffix=core.windows.net`
    const { text, count } = redactSecrets(input)

    expect(count).toBe(1)
    expect(text).not.toContain(AZURE_KEY)
    expect(text).toContain('[REDACTED:azure_storage_key]')
    // The field name itself, and every field around it -- including the one immediately after the
    // redacted value -- stay fully readable.
    expect(text).toBe(
      'DefaultEndpointsProtocol=https;AccountName=goat;AccountKey=[REDACTED:azure_storage_key];EndpointSuffix=core.windows.net',
    )
  })

  it('does not flag a bare 88-char base64 blob with no AccountKey= anchor (regression guard against an unanchored base64-shape pattern)', () => {
    expect(redactSecrets(AZURE_KEY)).toEqual({ text: AZURE_KEY, count: 0 })
  })

  // The spellings below are the ones this module has already been burned by on other patterns:
  // auth_bearer_token's own comment records that demanding an unquoted value missed every
  // JSON-carried header, and that demanding exactly one space made a second space the one thing
  // that defeated the whole pattern. An Azure connection string arrives in exactly those shapes --
  // a logged MCP result or api response quotes it, an appsettings file or a pretty-printed log
  // aligns it -- so each gets its own case here rather than being assumed away.
  it('redacts the JSON-quoted spelling a logged api response or MCP result carries', () => {
    const { text, count } = redactSecrets(`{"AccountKey": "${AZURE_KEY}"}`)

    expect(count).toBe(1)
    expect(text).not.toContain(AZURE_KEY)
    expect(text).toBe('{"AccountKey": "[REDACTED:azure_storage_key]"}')
  })

  it('redacts a hand-aligned AccountKey = value, not just the tight spelling', () => {
    const { text, count } = redactSecrets(`AccountKey = ${AZURE_KEY};EndpointSuffix=core.windows.net`)

    expect(count).toBe(1)
    expect(text).not.toContain(AZURE_KEY)
    expect(text).toContain('EndpointSuffix=core.windows.net')
  })

  it('redacts the lowercase and YAML-colon spellings', () => {
    expect(redactSecrets(`accountkey=${AZURE_KEY}`).count).toBe(1)
    expect(redactSecrets(`AccountKey: ${AZURE_KEY}`).count).toBe(1)
  })

  // Service Bus, Event Hubs and Relay spell the same credential SharedAccessKey.
  // SharedAccessKeyName sitting immediately before it is a plain identifier and must survive: it
  // is the case that proves the anchor keys on the separator rather than on the name prefix alone.
  it('redacts a Service Bus SharedAccessKey while leaving SharedAccessKeyName readable', () => {
    const sb = `Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${AZURE_KEY}`
    const { text, count } = redactSecrets(sb)

    expect(count).toBe(1)
    expect(text).not.toContain(AZURE_KEY)
    expect(text).toContain('SharedAccessKeyName=RootManageSharedAccessKey')
    expect(text).toContain('SharedAccessKey=[REDACTED:azure_storage_key]')
  })

  it('does not reach into the middle of a longer identifier such as myaccountkey=', () => {
    expect(redactSecrets(`myaccountkey=${AZURE_KEY}`).count).toBe(0)
  })
  it('does not re-match its own placeholder when the connection string is redacted twice', () => {
    const once = redactSecrets(`AccountKey=${AZURE_KEY};EndpointSuffix=core.windows.net`).text
    const { text, count } = redactSecrets(once)

    expect(count).toBe(0)
    expect(text).toBe(once)
  })
})

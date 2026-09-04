/**
 * The harness's own `WebFetch` tool must not be usable to reach a cloud metadata endpoint.
 *
 * token-goat's own fetching was already safe: `performHttpFetch` blocks link-local and private
 * ranges, re-checks every redirect hop, and pins DNS against rebinding. The gap was the other
 * surface. `WebFetch` is the harness's tool, running outside our process, and the only lever we
 * have is the pre-tool hook -- which, before this, consulted `webfetch.allow` / `webfetch.deny`
 * and nothing else. Both ship empty, so on a default install the answer to
 * `WebFetch http://169.254.169.254/latest/meta-data/iam/security-credentials/` was "go ahead".
 *
 * PROVENANCE
 *
 * HAND-DERIVED, from published addresses rather than from our own matcher: 169.254.169.254 (AWS
 * and Azure IMDS), 169.254.170.2 (ECS task credentials), fd00:ec2::254 (AWS IPv6 IMDS),
 * metadata.google.internal (GCP), 100.100.100.200 (Alibaba). Writing the fixtures from the
 * regex would only prove the regex matches itself.
 *
 * The `REACHABLE` half is the one that keeps this honest. A blocker that refuses everything passes
 * every "is it blocked" assertion, so the addresses that must still work are pinned too --
 * localhost above all, because refusing a local development server would cost real users real
 * work to defend against nothing.
 */
import { describe, expect, it } from 'vitest'

import { metadataEndpointRefusal } from '../src/url_policy.js'

const BLOCKED: ReadonlyArray<readonly [string, string]> = [
  ['AWS/Azure IMDS', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
  ['ECS task credentials', 'http://169.254.170.2/v2/credentials/abc'],
  ['any other link-local address', 'http://169.254.1.1/'],
  ['GCP metadata', 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/'],
  ['GCP metadata short name', 'https://metadata.goog/x'],
  ['Alibaba metadata', 'http://100.100.100.200/latest/meta-data/'],
  ['AWS IPv6 IMDS', 'http://[fd00:ec2::254]/latest/meta-data/'],
  ['a trailing-dot hostname, which resolves the same', 'http://metadata.google.internal./x'],
  ['an upper-case spelling', 'http://METADATA.GOOGLE.INTERNAL/x'],
  // Found by an adversarial review after the first version shipped. `new URL` rewrites an
  // IPv4-mapped literal to its hex form, so `[::ffff:169.254.169.254]` reaches `hostname` as
  // `[::ffff:a9fe:a9fe]` and matches neither the name sets nor the dotted-quad pattern.
  ['IPv4-mapped IPv6', 'http://[::ffff:169.254.169.254]/latest/meta-data/'],
  ['IPv4-mapped IPv6, already in hex', 'http://[::ffff:a9fe:a9fe]/latest/meta-data/'],
  ['IPv4-compatible IPv6', 'http://[::169.254.169.254]/latest/meta-data/'],
  ['the NAT64 well-known prefix, which a gateway translates back out', 'http://[64:ff9b::a9fe:a9fe]/x'],
  ['GCE bare short name, which answers the same as the fully qualified one', 'http://metadata/computeMetadata/v1/'],
  // Found by a second adversarial review. The first fix decoded three named encodings; these are the
  // three it did not name. Each is a real, standardised way to write an IPv4 address inside an IPv6
  // one, so each reached the metadata service through a check written to stop exactly that.
  ['the RFC 2765 translated form', 'http://[::ffff:0:a9fe:a9fe]/latest/meta-data/'],
  ['the RFC 8215 local-use NAT64 prefix', 'http://[64:ff9b:1::a9fe:a9fe]/x'],
  ['6to4, which carries the address in a different position entirely', 'http://[2002:a9fe:a9fe::]/x'],
  // EC2 resolves both of these to 169.254.169.254 inside a VPC.
  ['the EC2 instance-data short name', 'http://instance-data/latest/meta-data/'],
  ['the EC2 instance-data fully qualified name', 'http://instance-data.ec2.internal/latest/meta-data/'],
]

const REACHABLE: ReadonlyArray<readonly [string, string]> = [
  ['an ordinary website', 'https://example.com/docs'],
  ['a local development server', 'http://localhost:3000/api/health'],
  ['loopback by address', 'http://127.0.0.1:8080/'],
  ['a private LAN address, which is operator policy rather than a metadata endpoint', 'http://192.168.1.10/'],
  ['a host merely containing the digits', 'https://169.254.169.254.example.com/'],
  ['a path mentioning metadata', 'https://example.com/metadata.google.internal'],
  // The widened decode reads the last two groups of any IPv6 address, so an ordinary address has to
  // stay reachable or the widening has quietly become a block on IPv6.
  ['an ordinary IPv6 address', 'http://[2001:db8::1]/x'],
  ['an ordinary IPv6 address whose last groups are not link-local', 'http://[2001:db8::c0a8:1]/x'],
  ['a host merely starting with the instance-data name', 'https://instance-data.example.com/'],
]

describe('the cloud metadata floor on WebFetch', () => {
  it.each(BLOCKED)('refuses %s', (_label, url) => {
    const reason = metadataEndpointRefusal(url)
    expect(reason, `${url} was allowed through`).not.toBeNull()
    expect(reason!.length).toBeGreaterThan(0)
  })

  it.each(REACHABLE)('still allows %s', (_label, url) => {
    expect(metadataEndpointRefusal(url), `${url} was blocked, which breaks ordinary use`).toBeNull()
  })

  it('does not throw on input that is not a URL at all', () => {
    // The hook calls this on whatever the harness sent, which is not guaranteed to parse.
    expect(metadataEndpointRefusal('not a url')).toBeNull()
    expect(metadataEndpointRefusal('')).toBeNull()
  })
})

/**
 * Guard: the SSRF-relevant IP-range tables screenshot.ts and webfetch.ts each rely on stay merged
 * into url_policy.ts's isPrivateIpv4Octets/isPrivateIpv6Groups rather than drifting back into two
 * copies. Before this guard existed, screenshot.ts's headless-browser navigation policy carried its
 * own narrower table that omitted carrier-grade NAT (100.64.0.0/10, RFC 6598), IETF protocol
 * assignments (192.0.0.0/24, RFC 6890), benchmarking (198.18.0.0/15, RFC 2544), multicast
 * (224.0.0.0/4) and reserved space (240.0.0.0/4), all of which webfetch.ts's DNS-pinned fetch
 * policy already refused -- so a page render aimed at an internal service on one of those ranges
 * reached the browser and had its output OCR'd back into the model's context, a class of target the
 * fetch channel already blocked. Fixed by making both channels call the same two functions.
 *
 * Two halves:
 *  - Behavioural: a pinned population of representative addresses, one per range plus public
 *    controls, each with an explicit expected verdict (not merely "both agree", since two
 *    classifiers that agree on the wrong answer would still pass an equality-only check).
 *  - Structural: both screenshot.ts and webfetch.ts must import the shared range functions from
 *    url_policy.ts. Without this, someone could reintroduce a local octet-range literal in either
 *    file that happens to agree with the fixtures above today and still drift on a range this file
 *    does not enumerate.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isBlockedIpAddress } from '../../src/screenshot.js'
import { isPrivateIPv4, isPrivateIPv6 } from '../../src/webfetch.js'
import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/**
 * One fixture per range, tagged for provenance per this repo's testing convention.
 * HAND-DERIVED: every address is a representative literal drawn directly from the cited RFC's
 * defined range, computed independently of either classifier under test -- not read off our own
 * source. `blocked` is the outcome an SSRF policy protecting this threat model must produce.
 */
const FIXTURES: ReadonlyArray<{ label: string; address: string; blocked: boolean }> = [
  { label: 'v4 this-network 0.0.0.0/8', address: '0.0.0.1', blocked: true },
  { label: 'v4 loopback 127.0.0.0/8', address: '127.0.0.1', blocked: true },
  { label: 'v4 RFC1918 10.0.0.0/8', address: '10.1.2.3', blocked: true },
  { label: 'v4 RFC1918 172.16.0.0/12', address: '172.20.1.1', blocked: true },
  { label: 'v4 RFC1918 192.168.0.0/16', address: '192.168.1.1', blocked: true },
  { label: 'v4 link-local incl. cloud metadata 169.254.0.0/16 (RFC 3927)', address: '169.254.169.254', blocked: true },
  { label: 'v4 carrier-grade NAT 100.64.0.0/10 (RFC 6598)', address: '100.64.0.1', blocked: true },
  { label: 'v4 IETF protocol assignments 192.0.0.0/24 (RFC 6890)', address: '192.0.0.170', blocked: true },
  { label: 'v4 benchmarking 198.18.0.0/15 (RFC 2544)', address: '198.18.0.1', blocked: true },
  { label: 'v4 multicast 224.0.0.0/4 (RFC 1112)', address: '224.0.0.1', blocked: true },
  { label: 'v4 reserved 240.0.0.0/4 (RFC 1112)', address: '240.0.0.1', blocked: true },
  { label: 'v4 public control', address: '8.8.8.8', blocked: false },
  { label: 'v6 loopback ::1', address: '::1', blocked: true },
  { label: 'v6 unique-local fc00::/7 (RFC 4193)', address: 'fd12:3456::1', blocked: true },
  { label: 'v6 link-local fe80::/10 (RFC 4291)', address: 'fe80::1', blocked: true },
  { label: 'v6 multicast ff00::/8 (RFC 4291)', address: 'ff02::1', blocked: true },
  { label: 'v6 IPv4-mapped carrier-grade NAT ::ffff:100.64.0.1', address: '::ffff:100.64.0.1', blocked: true },
  { label: 'v6 IPv4-mapped multicast ::ffff:224.0.0.1', address: '::ffff:224.0.0.1', blocked: true },
  { label: 'v6 IPv4-translated loopback ::ffff:0:127.0.0.1', address: '::ffff:0:127.0.0.1', blocked: true },
  { label: 'v6 public control', address: '2606:4700:4700::1111', blocked: false },
]

function isV6(address: string): boolean {
  return address.includes(':')
}

describe('screenshot.ts and webfetch.ts SSRF classifiers agree per range', () => {
  const items = pinnedPopulation({
    what: 'SSRF IP-range fixtures',
    items: FIXTURES.map((f) => f.label),
    floor: 14,
    mustInclude: ['carrier-grade NAT 100.64.0.0/10', 'IETF protocol assignments 192.0.0.0/24', 'benchmarking 198.18.0.0/15', 'multicast 224.0.0.0/4', 'reserved 240.0.0.0/4'],
  })
  expect(items.length).toBe(FIXTURES.length)

  for (const fixture of FIXTURES) {
    it(`${fixture.label} (${fixture.address}): screenshot and webfetch both classify as ${fixture.blocked ? 'blocked' : 'allowed'}`, () => {
      const webfetchVerdict = isV6(fixture.address) ? isPrivateIPv6(fixture.address) : isPrivateIPv4(fixture.address)
      const screenshotVerdict = isBlockedIpAddress(fixture.address)
      expect(webfetchVerdict, `webfetch.ts classified ${fixture.address}`).toBe(fixture.blocked)
      expect(screenshotVerdict, `screenshot.ts classified ${fixture.address}`).toBe(fixture.blocked)
    })
  }

  it('both files import the shared range classifier from url_policy.ts rather than defining their own', () => {
    const files = pinnedPopulation({
      what: 'files that must share the SSRF range classifier',
      items: [path.join(SRC_DIR, 'screenshot.ts'), path.join(SRC_DIR, 'webfetch.ts')],
      floor: 2,
      mustInclude: ['screenshot.ts', 'webfetch.ts'],
    })
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      expect(text, `${path.basename(file)} must import isPrivateIpv4Octets from url_policy.ts`).toMatch(
        /import\s*\{[^}]*isPrivateIpv4Octets[^}]*\}\s*from\s*'\.\/url_policy\.js'/,
      )
      expect(text, `${path.basename(file)} must import isPrivateIpv6Groups from url_policy.ts`).toMatch(
        /import\s*\{[^}]*isPrivateIpv6Groups[^}]*\}\s*from\s*'\.\/url_policy\.js'/,
      )
    }
  })
})

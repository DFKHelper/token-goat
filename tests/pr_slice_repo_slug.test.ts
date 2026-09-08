/**
 * The repository slug and PR number that `pr-slice` interpolates into an authenticated `gh` call.
 *
 * `fetchPrComments` builds `repos/${repo}/pulls/${pr}/comments` and runs it through a `gh` that is
 * already holding the user's token, and `repo` can come from the git remote of the repository being
 * examined -- which that repository sets. `parseGithubRepoFromRemoteUrl` matched `[^/]+/[^/]+`, and
 * `..` contains no slash.
 *
 * Fixture provenance: HAND-DERIVED. The traversal payloads are constructed from GitHub's own REST
 * path shape (`repos/{owner}/{repo}/pulls/{number}/comments`, docs.github.com/en/rest/pulls) and the
 * argv position `--repo <value>` occupies, not from the validator's regex -- a fixture read off the
 * matcher would only prove the matcher matches itself.
 */

import { describe, expect, it } from 'vitest'

import { isSafePrNumber, isSafeRepoSlug, parseGithubRepoFromRemoteUrl } from '../src/pr_slice.js'

describe('isSafeRepoSlug', () => {
  it('accepts the ordinary slugs the command exists to serve', () => {
    for (const ok of ['anthropics/claude-code', 'a/b', 'My-Org/repo.js', 'org_1/repo_2', 'o/r.git.bak']) {
      expect(isSafeRepoSlug(ok), ok).toBe(true)
    }
  })

  it('refuses a segment that walks the API path', () => {
    // `repos/../../user/repos` reaches a different authenticated endpoint than the one the
    // command claims to be calling.
    for (const bad of ['../..', 'owner/..', '../repo', './x', 'a/./b']) {
      expect(isSafeRepoSlug(bad), bad).toBe(false)
    }
  })

  it('refuses a segment that would be read as a flag by gh', () => {
    expect(isSafeRepoSlug('-x/repo')).toBe(false)
    expect(isSafeRepoSlug('owner/--json')).toBe(false)
  })

  it('refuses anything that is not exactly two segments', () => {
    for (const bad of ['owner', 'a/b/c', '', '/', 'a/']) {
      expect(isSafeRepoSlug(bad), bad).toBe(false)
    }
  })

  it('refuses a segment carrying a character that has meaning in a URL path or query', () => {
    for (const bad of ['owner/repo?x=1', 'owner/repo#f', 'owner/re po', 'owner/repo%2e%2e', 'owner/re\\po']) {
      expect(isSafeRepoSlug(bad), bad).toBe(false)
    }
  })

  it('is the check the remote parser needs, because the parser itself admits traversal', () => {
    // Not a hypothetical about the validator: this is what the resolver returns today for a
    // remote URL a repository is free to set on itself.
    const resolved = parseGithubRepoFromRemoteUrl('https://github.com/../..')
    expect(resolved).toBe('../..')
    expect(isSafeRepoSlug(resolved!)).toBe(false)
  })
})

describe('isSafePrNumber', () => {
  it('accepts a bare number', () => {
    expect(isSafePrNumber('1')).toBe(true)
    expect(isSafePrNumber('4210')).toBe(true)
  })

  it('refuses anything else, including the flag and traversal shapes', () => {
    for (const bad of ['-1', '1/../..', '1 2', '', 'abc', '1;ls', '+1', '1.0']) {
      expect(isSafePrNumber(bad), bad).toBe(false)
    }
  })
})

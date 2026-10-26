import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildInfoPath, clearBuildInfo, computeBuildStamp, writeBuildInfo } from '../scripts/build-stamp.mjs'
import { checkBuild, compareBuilds, readBuildInfo, staleBuildNote } from '../src/build_stamp.js'
import { BUILD_STAMP } from '../src/version.js'

describe('the build stamp tells two builds of one version apart', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-build-stamp-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** What esbuild.config.mjs does at the end of a build, for a build made at `at`. */
  function build(version: string, at: string): string {
    const info = computeBuildStamp(root, new Date(at))
    writeBuildInfo(root, version, info)
    return info.stamp
  }

  it('falls back to unknown without a .git, and still stamps the time', () => {
    const info = computeBuildStamp(root, new Date('2026-10-24T15:30:12.345Z'))
    expect(info.commit).toBe('unknown')
    expect(info.stamp).toBe('unknown-20261024T153012Z')
  })

  it('yields different stamps for two builds of the same version, and writes the one it computed', () => {
    const first = build('2.9.32', '2026-10-24T10:00:00Z')
    expect(readBuildInfo(path.join(root, 'dist'))?.stamp).toBe(first)
    const second = build('2.9.32', '2026-10-24T11:00:00Z')
    expect(second).not.toBe(first)
    expect(readBuildInfo(path.join(root, 'dist'))).toMatchObject({ version: '2.9.32', stamp: second, builtAt: '2026-10-24T11:00:00.000Z' })
  })

  it('warns when the process runs an earlier build of the same version than the one on disk', () => {
    const running = build('2.9.32', '2026-10-24T10:00:00Z')
    const onDisk = build('2.9.32', '2026-10-24T11:00:00Z')
    const row = checkBuild(path.join(root, 'dist'), { stamp: running, version: '2.9.32' }, root)
    expect(row.status).toBe('warn')
    expect(row.message).toContain(running)
    expect(row.message).toContain(onDisk)
    expect(staleBuildNote(path.join(root, 'dist'), { stamp: running, version: '2.9.32' }, root)).toContain(onDisk)
  })

  it('is quiet when the process is the build on disk', () => {
    const stamp = build('2.9.32', '2026-10-24T10:00:00Z')
    const row = checkBuild(path.join(root, 'dist'), { stamp, version: '2.9.32' }, root)
    expect(row.status).toBe('ok')
    expect(row.message).toContain(stamp)
    expect(staleBuildNote(path.join(root, 'dist'), { stamp, version: '2.9.32' }, root)).toBeNull()
  })

  it('leaves a version change to the upgrade path and an unknown stamp unjudged', () => {
    const installed = { version: '2.9.33', stamp: 'abc1234-20261024T110000Z' }
    expect(compareBuilds({ stamp: 'abc1234-20261024T100000Z', version: '2.9.32' }, installed).kind).toBe('unverifiable')
    expect(compareBuilds({ stamp: 'unknown', version: '2.9.33' }, installed).kind).toBe('unverifiable')
    expect(compareBuilds({ stamp: 'abc1234-20261024T100000Z', version: '2.9.33' }, { version: '2.9.33', stamp: 'unknown' }).kind).toBe('unverifiable')
    expect(compareBuilds({ stamp: 'x', version: '2.9.33' }, null).kind).toBe('unverifiable')
  })

  it('reads a missing, empty or malformed build-info.json as no stamp', () => {
    const dist = path.join(root, 'dist')
    expect(readBuildInfo(dist)).toBeNull()
    fs.mkdirSync(dist)
    for (const body of ['', 'not json', 'null', '{"version":"1.0.0"}', '{"version":"1.0.0","stamp":""}', '{"stamp":"a"}']) {
      fs.writeFileSync(buildInfoPath(root), body)
      expect(readBuildInfo(dist), body).toBeNull()
    }
  })

  it('clears the file before a build so an interrupted one vouches for nothing', () => {
    build('2.9.32', '2026-10-24T10:00:00Z')
    clearBuildInfo(root)
    expect(fs.existsSync(buildInfoPath(root))).toBe(false)
  })

  it('reports unknown for source run outside a build', () => {
    expect(BUILD_STAMP).toBe('unknown')
    expect(checkBuild(path.join(root, 'dist'), undefined, root).status).toBe('ok')
  })

  describe('against the source build reachable from the working directory', () => {
    const installed = (stamp: string): { dist: string; running: { stamp: string; version: string } } => {
      writeBuildInfo(path.join(root, 'install'), '2.9.32', { commit: stamp.split('-')[0], builtAt: '2026-10-24T10:00:00.000Z', stamp })
      return { dist: path.join(root, 'install', 'dist'), running: { stamp, version: '2.9.32' } }
    }

    /** A checkout at root/source named `name` with build-info of `stamp` (none when null); returns a directory inside it to judge from. */
    function checkout(name: string, stamp: string | null, version = '2.9.32'): string {
      const src = path.join(root, 'source')
      fs.mkdirSync(path.join(src, 'work'), { recursive: true })
      fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name, version }))
      if (stamp !== null) writeBuildInfo(src, version, { commit: stamp.split('-')[0], builtAt: '2026-10-24T11:00:00.000Z', stamp })
      return path.join(src, 'work')
    }

    it('warns when the installed copy was never rebuilt past the source build of the same version', () => {
      const { dist, running } = installed('aaa1111-20261024T100000Z')
      const from = checkout('token-goat', 'bbb2222-20261024T110000Z')
      const row = checkBuild(dist, running, from)
      expect(row.status).toBe('warn')
      expect(row.message).toContain('aaa1111-20261024T100000Z')
      expect(row.message).toContain('bbb2222-20261024T110000Z')
      expect(staleBuildNote(dist, running, from)).toContain('bbb2222-20261024T110000Z')
    })

    it('is quiet when the installed copy is the source build', () => {
      const { dist, running } = installed('aaa1111-20261024T100000Z')
      const from = checkout('token-goat', 'aaa1111-20261024T100000Z')
      expect(checkBuild(dist, running, from).status).toBe('ok')
      expect(checkBuild(dist, running, from).message).toContain('matches the source build')
      expect(staleBuildNote(dist, running, from)).toBeNull()
    })

    it('reports unverifiable, never a match, when no source build is reachable', () => {
      const { dist, running } = installed('aaa1111-20261024T100000Z')
      const row = checkBuild(dist, running, root)
      expect(row.message).toContain('unverifiable')
      expect(row.message).not.toContain('matches')
      expect(staleBuildNote(dist, running, root)).toBeNull()
    })

    it('does not take a checkout without build-info, or one named otherwise, as the source', () => {
      const { dist, running } = installed('aaa1111-20261024T100000Z')
      expect(checkBuild(dist, running, checkout('token-goat', null)).message).toContain('unverifiable')
      expect(checkBuild(dist, running, checkout('not-token-goat', 'bbb2222-20261024T110000Z')).message).toContain('unverifiable')
    })

    it('leaves a source build of another version unjudged', () => {
      const { dist, running } = installed('aaa1111-20261024T100000Z')
      const row = checkBuild(dist, running, checkout('token-goat', 'bbb2222-20261024T110000Z', '2.9.33'))
      expect(row.status).toBe('ok')
      expect(row.message).toContain('unverifiable against')
    })

    it('leaves a source run, whose own stamp is unknown, unjudged against a real source build', () => {
      const { dist } = installed('aaa1111-20261024T100000Z')
      const row = checkBuild(dist, { stamp: 'unknown', version: '2.9.32' }, checkout('token-goat', 'bbb2222-20261024T110000Z'))
      expect(row.status).toBe('ok')
      expect(row.message).toContain('unverifiable against')
    })
  })
})

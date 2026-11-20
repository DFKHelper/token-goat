// A find start that steps back up to a root through a dotted path. HAND-DERIVED from POSIX path resolution.
import { describe, expect, it } from 'vitest'
import { detectUnboundedWalk, type WalkContext } from '../src/unbounded_walk.js'

const POSIX: WalkContext = { windows: false, powershell: false }

function form(command: string): string | null {
  return detectUnboundedWalk(command, POSIX)?.form ?? null
}

describe('a find whose start resolves to a root through dotted segments', () => {
  it.each([
    ['cd / && find ./etc/..'],
    ['cd / && find etc/../'],
    ['cd / && find ./a/b/../..'],
    ['find /etc/..'],
    ['find /usr/../'],
  ])('refuses %s', (command) => {
    expect(form(command), command).toBe('find')
  })

  it.each([
    ['cd / && find ./etc -name x'],
    ['cd / && find ./etc/../usr -name x'],
    ['find /usr/../etc -name x'],
    ['find ./src/.. -name x'],
    ['cd / && find ./etc/.. -maxdepth 1 -name x'],
    ['find / -maxdepth 1 -name x'],
  ])('still passes %s', (command) => {
    expect(form(command), command).toBe(null)
  })
})

describe('a find start made only of dots and separators is the working directory', () => {
  const starts = ['././', './.', './/./', '.\\.\\', './/.//']
  it.each(starts)('refuses %s after cd /', (start) => {
    expect(form(`cd / && find ${start}`), start).toBe('find')
  })
  it.each(starts)('passes %s with -maxdepth 1 after cd /', (start) => {
    expect(form(`cd / && find ${start} -maxdepth 1 -name x`), start).toBe(null)
  })
  it.each(starts)('passes %s with no root in effect', (start) => {
    expect(form(`find ${start}`), start).toBe(null)
  })
})

describe('a relative cd that resolves back to the root keeps the root state', () => {
  it.each([
    ['cd / && cd ./etc/.. && find .'],
    ['cd / && cd etc/../ && find .'],
    ['cd / && cd ./a/b/../.. && find .'],
    ['cd / && cd ./.. && find .'],
    ['cd / && cd etc/$X/.. && find .'],
    ['cd / && cd ./* && find .'],
  ])('refuses %s', (command) => {
    expect(form(command), command).toBe('find')
  })

  it.each([
    ['cd / && cd ./etc && find .'],
    ['cd / && cd ./etc/../usr && find .'],
    ['cd /tmp && cd ./etc/.. && find .'],
  ])('passes %s', (command) => {
    expect(form(command), command).toBe(null)
  })

  it('keeps refusing find ./etc/.. -prune: no recorded real case asks to loosen it (ruling 165)', () => {
    expect(form('cd / && find ./etc/.. -prune'), 'ruling 165').toBe('find')
  })
})

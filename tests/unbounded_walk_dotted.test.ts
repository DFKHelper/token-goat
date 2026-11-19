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

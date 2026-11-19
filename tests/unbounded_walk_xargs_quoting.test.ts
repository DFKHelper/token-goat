// HAND-DERIVED: judged by what a POSIX shell runs; quoted `xargs` is text, unquoted it is a command.
import { describe, expect, it } from 'vitest'
import { detectUnboundedWalk, type WalkContext } from '../src/unbounded_walk.js'

const POSIX: WalkContext = { windows: false, powershell: false }
const GIT_BASH_ON_WINDOWS: WalkContext = { windows: true, powershell: false }

function form(command: string, ctx: WalkContext = POSIX): string | null {
  return detectUnboundedWalk(command, ctx)?.form ?? null
}

describe('the xargs substitution rule judges only an xargs command word outside quotes', () => {
  it.each([
    ["printf '%s\\n' 'example xargs $(literal)'"],
    ["echo 'run: ls | xargs rm `ls`'"],
    ['echo "see xargs $(date)"'],
    ["git commit -m 'document xargs $(find) handling'"],
  ])('lets quoted text through: %s', (command) => {
    expect(form(command), command).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS), command).toBeNull()
  })

  it.each([
    ['ls | xargs rm $(find /)'],
    ['ls | xargs rm "$(find /)"'],
    ['ls | xargs rm `find /`'],
  ])('still refuses a real xargs fed a root walk: %s', (command) => {
    expect(form(command), command).not.toBeNull()
  })

  it.each([
    ['ls | xargs rm $(echo x)'],
    ['ls | xargs rm "$(echo x)"'],
    ['ls | xargs rm `echo x`'],
    ['ls | xargs $(echo find) / -name x'],
  ])('still refuses a substitution inside a real xargs, whatever it runs: %s', (command) => {
    expect(form(command), command).toBe('xargs')
  })
})

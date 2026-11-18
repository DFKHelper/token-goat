// HAND-DERIVED: heads computed from the rule in the D1F brief, independently of the implementation.
import { describe, expect, it } from 'vitest'

import { commandHead } from '../src/hooks_bash_commands.js'

describe('commandHead', () => {
  it.each([
    ['API_KEY=sk-123 npm x', 'npm'],
    ['FOO=1 BAR="a b" terraform plan', 'terraform'],
    ['FOO=a=b npm test', 'npm'],
    ['Kubectl get pods', 'kubectl'],
    ['npm test', 'npm'],
    ['tool.exe run', 'tool.exe'],
    ['my\\tool run', 'tool'],
    ['node_modules/.bin/vitest run', 'vitest'],
    ['cargo build', 'cargo'],
  ])('derives the head of %j as %j', (cmd, head) => {
    expect(commandHead(cmd)).toBe(head)
  })

  it.each([
    './private/deploy-prod.sh --now',
    '../private/deploy.sh',
    'C:/Users/me/secret-tool.exe run',
    'c:\\Users\\me\\secret-tool.exe run',
    '.\\private\\tool.exe run',
    '/usr/local/bin/tool run',
    '~/bin/tool run',
    'x=1 ./run.sh',
    'RUN.SH',
    'deploy.PS1 now',
    'tool.py',
    'build.mjs',
  ])('collapses the path or script %j to script', (cmd) => {
    expect(commandHead(cmd)).toBe('script')
  })

  it.each([
    '$(whoami)',
    '"my tool" x',
    "'my tool' x",
    '',
    '   ',
    'FOO=1',
    'FOO=1 BAR=2',
    'echo$x run',
    'tool`id` run',
    'tool;rm run',
  ])('collapses the unsafe or empty command %j to other', (cmd) => {
    expect(commandHead(cmd)).toBe('other')
  })

  it('cuts a 60-character head to 32 characters', () => {
    const long = 'a'.repeat(60)
    expect(commandHead(`${long} run`)).toBe('a'.repeat(32))
  })

  it('lowercases the head before the length cut', () => {
    expect(commandHead('NPM test')).toBe('npm')
  })
})

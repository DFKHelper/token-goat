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
    '"$(x)" y',
    'A=1 $(x)',
  ])('collapses the unsafe or empty command %j to other', (cmd) => {
    expect(commandHead(cmd)).toBe('other')
  })

  it('files a 60-character head as other, since a head is at most 16 characters', () => {
    const long = 'a'.repeat(60)
    expect(commandHead(`${long} run`)).toBe('other')
  })

  it.each([
    ['sk-abc123def456 run', 'other'],
    ['ghp_aB3xyz run', 'other'],
    ['sk-abcdefgh run', 'other'],
    ['ghpabcdef run', 'other'],
    ['glpatabcdef run', 'other'],
    ['eyjhbgcio run', 'other'],
    ['a1b2c3d4e5f6 run', 'other'],
    ['tool.exe run', 'other'],
    ['terraform plan', 'terraform'],
    ['docker-compose up', 'docker-compose'],
    ['kubectl get pods', 'kubectl'],
    ['python3 x', 'python3'],
    ['g++ main.cpp', 'g++'],
  ])('keeps only a known or plain-lowercase head: %j gives %j', (cmd, head) => {
    expect(commandHead(cmd)).toBe(head)
  })

  it.each([
    ['FOO=a\\ ghp_xxx cmd', 'cmd'],
    ['FOO="a \\" ghp_xxx" cmd', 'cmd'],
    ['FOO=a\\ ghp_xxx', 'other'],
  ])('keeps an escaped space inside its word: %j gives %j', (cmd, head) => {
    expect(commandHead(cmd)).toBe(head)
  })

  it.each([
    ['FOO=$(echo hello world) npm test', 'npm'],
    ['FOO=$(echo "a b" | tr a c) terraform plan', 'terraform'],
    ['FOO=`echo hi there` npm test', 'npm'],
    ['FOO=$(echo $(echo a b) c d) cargo build', 'cargo'],
    ['$(echo git) status', 'other'],
    ['$(pwd)/run.sh now', 'other'],
    ['`echo git` status', 'other'],
    ['npm$(echo x) test', 'other'],
    ['FOO=$(echo unterminated npm test', 'other'],
  ])('keeps a substitution out of the head: %j gives %j', (cmd, head) => {
    expect(commandHead(cmd)).toBe(head)
  })

  it('returns for a single 2 MB word, plain and inside an open quote', () => {
    const word = 'a'.repeat(2 * 1024 * 1024)
    expect(commandHead(word)).toBe('other')
    expect(commandHead(`"${word}`)).toBe('other')
  })

  it('returns a string for a 2 MB run of substitution openers and of single quotes', () => {
    expect(typeof commandHead('$('.repeat(1024 * 1024))).toBe('string')
    expect(typeof commandHead("'".repeat(2 * 1024 * 1024))).toBe('string')
  })

  it('lowercases the head before the length cut', () => {
    expect(commandHead('NPM test')).toBe('npm')
  })
})

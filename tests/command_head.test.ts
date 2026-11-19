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
    ['tool.exe run', 'tool'],
    ['tool.dll run', 'other'],
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

  // HAND-DERIVED: the wrapper table of the E6 brief; a plain form records the tool it runs.
  it.each([
    ['env FOO=bar rg x', 'rg'],
    ['env -i FOO=bar rg x', 'rg'],
    ['env -u HOME rg x', 'rg'],
    ['FOO=bar rg x', 'rg'],
    ['sudo rg x', 'rg'],
    ['sudo -E -u me rg x', 'rg'],
    ['sudo -u me rg x', 'rg'],
    ['time rg x', 'rg'],
    ['time -p rg x', 'rg'],
    ['nice rg x', 'rg'],
    ['nice -n 5 rg x', 'rg'],
    ['nice -n -5 rg x', 'rg'],
    ['timeout 10 rg x', 'rg'],
    ['timeout 1.5m rg x', 'rg'],
    ['timeout --foreground -k 5 -s KILL 10 rg x', 'rg'],
    ['command rg x', 'rg'],
    ['command -p rg x', 'rg'],
    ['nohup rg x', 'rg'],
    ['sudo env FOO=bar rg x', 'rg'],
    ['Sudo RG x', 'rg'],
    ['env rg.exe x', 'rg'],
  ])('unwraps the plain wrapper form %j to the tool %j', (cmd, head) => {
    expect(commandHead(cmd)).toBe(head)
  })

  it.each([
    ['env FOO="a b" rg', 'env'],
    ["env FOO='a b' rg", 'env'],
    ['env FOO=$(x) rg', 'env'],
    ['env $(x) rg', 'env'],
    ['env -x rg', 'env'],
    ['env -u "$U" rg', 'env'],
    ['env -u', 'env'],
    ['env FOO=secret123', 'env'],
    ['env FOO=secret123 ./run.sh', 'env'],
    ['sudo -u "$U" rg', 'sudo'],
    ['sudo -u $U rg', 'sudo'],
    ['sudo -x rg', 'sudo'],
    ['sudo -u', 'sudo'],
    ['sudo', 'sudo'],
    ['time', 'time'],
    ['time -z rg x', 'time'],
    ['time $(x) rg', 'time'],
    ['nice -n x rg', 'nice'],
    ['nice -n $N rg', 'nice'],
    ['nice -n 5', 'nice'],
    ['timeout $N rg', 'timeout'],
    ['timeout 10', 'timeout'],
    ['timeout rg x', 'timeout'],
    ['timeout -k $K 10 rg', 'timeout'],
    ['timeout 10 "rg" x', 'timeout'],
    ['command "rg" x', 'command'],
    ['command -v rg', 'command'],
    ['command $(x)', 'command'],
    ['nohup', 'nohup'],
    ['nohup -x rg', 'nohup'],
    ['sudo TOOL_B=2 rg x', 'sudo'],
    ['sudo env time rg x', 'sudo'],
    ['env sk-abcdefgh run', 'env'],
    ['sudo ./deploy.sh', 'sudo'],
    ['sudo C:/tools/rg.exe x', 'sudo'],
    ['time sudo', 'time'],
  ])('keeps the wrapper for the unsafe sibling %j, recording %j', (cmd, head) => {
    expect(commandHead(cmd)).toBe(head)
  })

  it('leaves npx, npm exec and pnpm exec recorded as themselves', () => {
    expect(commandHead('npx vitest run')).toBe('npx')
    expect(commandHead('npm exec vitest')).toBe('npm')
    expect(commandHead('pnpm exec vitest')).toBe('pnpm')
  })

  it.each([
    ['rg.exe x', 'rg'],
    ['RG.EXE x', 'rg'],
    ['Rg.Exe x', 'rg'],
    ['.exe x', 'other'],
    ['rg.exe.exe x', 'other'],
    ['sk-abcdefgh.exe x', 'other'],
    ['"rg.exe" x', 'other'],
    ['C:/tools/rg.exe x', 'script'],
    ['c:\\tools\\rg.exe x', 'script'],
    ['./rg.exe x', 'script'],
  ])('strips .exe from a bare head only: %j gives %j', (cmd, head) => {
    expect(commandHead(cmd)).toBe(head)
  })

  it('records no head holding =, /, a quote, $ or whitespace for any row of the wrapper tables', () => {
    const cmds = [
      'env FOO="a b" rg', 'env $(x) rg', 'env FOO=secret123', 'sudo -u "$U" rg', 'timeout $N rg', 'time',
      'env FOO=bar rg x', 'sudo -u me rg x', 'nice -n 5 rg x', 'timeout 10 rg x', 'command rg x', 'nohup rg x',
      'env A=b/c rg x', 'env A="x y" rg', "env A='x y' rg", 'sudo env A=1 rg', 'time sudo env rg', 'env -u X',
    ]
    for (const cmd of cmds) expect(commandHead(cmd), cmd).not.toMatch(/[=/'"`$\s]/)
  })

  it('lowercases the head before the length cut', () => {
    expect(commandHead('NPM test')).toBe('npm')
  })
})

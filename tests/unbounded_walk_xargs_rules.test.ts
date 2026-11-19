// Provenance: HAND-DERIVED from the xargs rules in src/unbounded_walk.ts and the reviews of that guard.
// Each command is a shell line whose meaning follows from GNU findutils xargs, grep, ls and du, fd, rg, git.
import { describe, expect, it } from 'vitest'
import { detectUnboundedWalk, type WalkContext } from '../src/unbounded_walk.js'

const POSIX: WalkContext = { windows: false, powershell: false }
const GIT_BASH_ON_WINDOWS: WalkContext = { windows: true, powershell: false }

function form(command: string, ctx: WalkContext): string | null {
  return detectUnboundedWalk(command, ctx)?.form ?? null
}

describe('xargs allowance -- the commands it exists for', () => {
  it.each([
    ['git ls-files | xargs du'],
    ['git ls-files -z | xargs -0 du -sh'],
    ['git diff --name-only | xargs ls -R'],
    ['git diff --cached --name-only HEAD~1 | xargs du'],
    ['fd -e ts src | xargs du -h'],
    ['echo src tests | xargs du -sh'],
    ["printf '%s\\n' src | xargs du"],
    ['find src -maxdepth 1 -type d | xargs du -sh'],
    ['ls src | xargs du'],
    ['rg --files src | xargs du -h'],
    ['git ls-files | xargs -n 1 -P 4 du'],
    // a name lister vouches like any lister: the walker is the bare walker in the cwd (refused at a root below)
    ['rg -l x | xargs du'],
    ["find src -name '*.ts' | xargs du"],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
  })

  it.each([
    ['cd / && rg -l x | xargs du'],
    ["cd / && find src -name '*.ts' | xargs du"],
    ['cd ~ && rg -l x | xargs du'],
    ["cd ~ && find src -name '*.ts' | xargs du"],
  ])('refuses %s once the cwd is a root or home', (command) => {
    expect(form(command, POSIX)).not.toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).not.toBeNull()
  })
})

describe('xargs allowance -- rule 1: the lister is one plain command from a short list', () => {
  it.each<readonly [string, string]>([
    ['git ls-files | cat | xargs du', 'xargs'],
    ['env ls src | xargs du', 'xargs'],
    ['sudo ls src | xargs du', 'xargs'],
    ['command ls src | xargs du', 'xargs'],
    ['time ls src | xargs du', 'xargs'],
    ['nice ls src | xargs du', 'xargs'],
    ['FOO=1 ls src | xargs du', 'xargs'],
    ['(echo /) | xargs du', 'xargs'],
    ['{ echo /; ls src; } | xargs du', 'xargs'],
    ['ls $D | xargs du', 'xargs'],
    ['ls `pwd` | xargs du', 'xargs'],
    ['ls s*c | xargs du', 'xargs'],
    ['ls s?c | xargs du', 'xargs'],
    ['ls s[a]c | xargs du', 'xargs'],
    ['ls {src,tests} | xargs du', 'xargs'],
    ['ls s\\rc | xargs du', 'xargs'],
    ['cd / && git ls-files | xargs du', 'xargs'],
    ['git ls-files -o | xargs du', 'xargs'],
    ['git ls-files --others | xargs du', 'xargs'],
    ['git ls-files --full-name | xargs du', 'xargs'],
    ['git ls-files -C x | xargs du', 'xargs'],
    ['git --git-dir=x ls-files | xargs du', 'xargs'],
    ['git diff --name-only --no-index a b | xargs du', 'xargs'],
    ['git diff --name-only --relative | xargs du', 'xargs'],
    ['git diff | xargs du', 'xargs'],
    ['export GIT_WORK_TREE=/; git ls-files -o | xargs du', 'xargs'],
    ['git diff --no-index --name-only /home /home2 | xargs du', 'xargs'],
    ['fd -e ts / | xargs du', 'xargs'],
    ['fd -e ts ~ | xargs du', 'xargs'],
    ['fd -e ts .. | xargs du', 'xargs'],
    ['fd --extension=ts | xargs du', 'xargs'],
    ['fd -E x | xargs du', 'xargs'],
    ['fd -d1 --search-path=/ | xargs du', 'xargs'],
    ['fd -d1 --base-directory=/ | xargs du', 'xargs'],
    ['fd -d1 --search-path=~/.. | xargs du', 'xargs'],
    ['rg --files -g x | xargs du', 'xargs'],
    ['rg --files --max-depth=1 | xargs du', 'xargs'],
    ['find src -name a/b | xargs du', 'xargs'],
    ['find src -maxdepth 1 -exec echo / ; | xargs du', 'xargs'],
    ['find -L src | xargs du', 'xargs'],
    ['ls -R | xargs du', 'xargs'],
    ['ls -la src | xargs du', 'xargs'],
    ['ls .. | xargs du', 'xargs'],
    ['ls -- src | xargs du', 'xargs'],
    ['echo -e / | xargs du', 'xargs'],
    ['echo . | xargs du', 'xargs'],
    ['echo a:b | xargs du', 'xargs'],
    ['echo ../x | xargs du', 'xargs'],
    ['echo src/../.. | xargs du', 'xargs'],
    ['echo ~root/.. | xargs du', 'xargs'],
    ['ls -d ~root/.. | xargs du', 'xargs'],
    ["printf '%s\\n' / | xargs du", 'xargs'],
    ["printf '%s' src | xargs du", 'xargs'],
    ["printf '%s\\n%s\\n' src tests | xargs du", 'xargs'],
    ["printf '%.0s/' x | xargs du", 'xargs'],
    ['printf src | xargs du', 'xargs'],
    ['xargs du', 'xargs'],
    ['cat list | xargs du', 'xargs'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })
})

describe('xargs allowance -- rule 3: xargs options come from an exact set of short forms', () => {
  it.each<readonly [string, string]>([
    ['git ls-files | xargs -I{} du', 'xargs'],
    ['git ls-files | xargs -i du', 'xargs'],
    ['git ls-files | xargs -J{} du', 'xargs'],
    ['git ls-files | xargs -a rootlist du', 'xargs'],
    ['git ls-files | xargs --arg-file=rootlist du', 'xargs'],
    ['git ls-files | xargs -0n 1 du', 'xargs'],
    ['git ls-files | xargs -n x du', 'xargs'],
    ['git ls-files | xargs -s 100 du', 'xargs'],
    ['git ls-files | xargs -- du', 'xargs'],
    ['git ls-files | xargs -E x du', 'xargs'],
    ['echo / | xargs --arg rootlist du', 'xargs'],
    ['echo / | xargs --max-a 1 du', 'xargs'],
    ['echo / | xargs --max-chars 100 du', 'xargs'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })
})

describe('xargs allowance -- rule 4: the command is a walker with flags only', () => {
  it.each<readonly [string, string]>([
    ['echo / | xargs -I{} du {}', 'xargs'],
    ['cat rootlist | xargs -I{} du {}', 'xargs'],
    ['echo / | xargs du .', 'xargs'],
    ['git ls-files | xargs du {}', 'xargs'],
    ['git ls-files | xargs du src', 'xargs'],
    ['git ls-files | xargs ls -R /', 'ls'],
    ['git ls-files | xargs find / -name x', 'find'],
    ["echo / | xargs sh -c 'du \"$@\"' _", 'xargs'],
    ["cat rootlist | xargs sh -c 'du \"$@\"' _", 'xargs'],
    ["git ls-files | xargs bash -c 'du \"$@\"'", 'xargs'],
    ['git ls-files | xargs env du', 'xargs'],
    ['git ls-files | xargs nice du', 'xargs'],
    ['git ls-files | xargs sudo du', 'xargs'],
    ['git ls-files | xargs /usr/bin/du', 'xargs'],
    ['git ls-files | xargs du --files0-from=x', 'xargs'],
    ['git ls-files | xargs du --files0-from x', 'xargs'],
    ['git ls-files | xargs find -exec rm {} +', 'xargs'],
    ['git ls-files | xargs find -delete', 'xargs'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })
})

describe('xargs allowance -- Ruling 49: a walker with its own start path or a search is not exempt', () => {
  it.each<readonly [string, string]>([
    ['cat rootlist | xargs find .', 'xargs'],
    ['cat rootlist | xargs find src', 'xargs'],
    ['xargs find . < rootlist', 'xargs'],
    ['cat rootlist | xargs -a rootlist find . -name x', 'xargs'],
    ['cat rootlist | xargs -I{} find . -name {}', 'xargs'],
    ['cat rootlist | xargs find . -newer', 'xargs'],
    ['cat rootlist | xargs find src -name x -o -path', 'xargs'],
    ['cat rootlist | xargs find . -maxdepth 1', 'xargs'],
    ['cat rootlist | xargs find . -name x', 'xargs'],
    ['git ls-files | xargs find . -name x', 'xargs'],
    ['git ls-files | xargs find .', 'xargs'],
    ['cat rootlist | xargs find -L .', 'xargs'],
    ['cat rootlist | xargs find', 'xargs'],
    ['cat rootlist | xargs rg --files', 'xargs'],
    ['cat rootlist | xargs rg x', 'xargs'],
    ['cat rootlist | xargs grep -r x', 'xargs'],
    ['cat rootlist | xargs grep -rn x', 'xargs'],
    ['cat rootlist | xargs fd .', 'xargs'],
    ['git ls-files | xargs rg x src', 'xargs'],
    ['git ls-files | xargs rg --files x', 'xargs'],
    ['git ls-files | xargs rg -e x y', 'xargs'],
    ['git ls-files | xargs grep -r x src', 'xargs'],
    ['git ls-files | xargs rg x < rootlist', 'xargs'],
    ['rg --files /', 'rg'],
    ['rg x /', 'rg'],
    ['grep -r x /', 'grep'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })

  it.each([
    ['git ls-files | xargs rg x'],
    ['git ls-files | xargs grep -n x'],
    ['git ls-files | xargs grep -rn x'],
    ['git ls-files | xargs rg --files'],
    ['git ls-files | xargs rg -e x'],
    ['git ls-files | xargs find -maxdepth 1 -name x'],
    ['cat rootlist | xargs grep x'],
    ['cat rootlist | xargs grep -n x'],
    ['cat rootlist | xargs grep -l find'],
    ['grep x /'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
  })
})

describe('xargs allowance -- rule 5: nothing after the command reads a file or here-string', () => {
  it.each<readonly [string, string]>([
    ['git ls-files | xargs du < rootlist', 'xargs'],
    ['git ls-files | xargs du <rootlist', 'xargs'],
    ['git ls-files | xargs du <<< /', 'du'],
    ['git ls-files |& xargs du', 'xargs'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })
})

describe('walk guard -- root spellings', () => {
  it.each<readonly [string, string]>([
    ['du ~root/..', 'du'],
    ['du ~root', 'du'],
    ['du /mnt', 'du'],
    ['du /mnt/', 'du'],
    ['du /mnt/c/..', 'du'],
    ['du /cygdrive', 'du'],
    ['du /cygdrive/c', 'du'],
    ['du //host/share', 'du'],
    ['du //?/C:/', 'du'],
    ['du C:.', 'du'],
    ['du C:..', 'du'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe(expected)
  })

  it.each([
    ['du ~/proj'],
    ['du ~root/proj'],
    ['du /mnt/c/Users/proj'],
    ['du C:proj'],
    ['du /usr/lib'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
  })
})

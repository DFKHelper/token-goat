/** The scripts under .lefthook-scripts that the suite itself runs (run-test.sh, prepush-focus.sh, wsl-gate.sh) must run on bash 3.2, the /bin/bash of every macOS machine: the macOS CI job executes them with it. A bash-4 builtin there exits 127 ("mapfile: command not found") on macOS while passing on Linux and Git for Windows, which ship bash 5. Two scripts are workstation-only and name the bash they need in ALLOWED; each must still contain a flagged construct, so the list cannot go stale. Fixtures are HAND-DERIVED: each snippet is a construct whose minimum bash version is stated in the bash manual's "Bash Features" and the CHANGES file shipped with bash 4.0 to 5.1, written independently of the matchers below. */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const DIR = path.join(fileURLToPath(new URL('../..', import.meta.url)), '.lefthook-scripts')

/** Constructs bash 3.2 lacks, each with the first bash that has it. */
const BASH4_ONLY: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'mapfile / readarray (4.0)', re: /(^|[\s;&|(])(mapfile|readarray)(\s|$)/ },
  { name: 'associative array: declare/local/typeset/readonly -A (4.0)', re: /\b(declare|local|typeset|readonly)\s+-[a-zA-Z]*A/ },
  { name: 'global declaration: declare/local/typeset -g (4.2)', re: /\b(declare|local|typeset)\s+-[a-zA-Z]*g/ },
  { name: 'shopt globstar, lastpipe, autocd, dirspell, checkjobs (4.x)', re: /\bshopt\s+(-[a-z]+\s+)*(globstar|lastpipe|autocd|dirspell|checkjobs)\b/ },
  { name: 'printf time format %(...)T (4.2)', re: /\bprintf\b[^\n]*%\([^)]*\)T/ },
  { name: 'fd-variable redirect {name}< {name}> {name}>> (4.1)', re: /(^|[\s;&|(])\{[A-Za-z_][A-Za-z_0-9]*\}(<|>)/ },
  { name: 'read -N (4.1)', re: /\bread\b[^\n]*\s-[a-zA-Z]*N/ },
  { name: 'case-changing expansion ${v,,} ${v^^} (4.0)', re: /\$\{[A-Za-z_][A-Za-z_0-9]*(,,?|\^\^?)[^}]*\}/ },
  { name: 'case fallthrough ;& ;;& (4.0)', re: /;;?&(?!&)/ },
  { name: 'pipe stderr |& (4.0)', re: /\|&/ },
  { name: 'append both streams &>> (4.0)', re: /&>>/ },
  { name: 'coproc (4.0)', re: /(^|[\s;&|(])coproc(\s|$)/ },
  { name: 'negative array subscript a[-1] (4.3)', re: /\[\s*-([0-9]+|\$\{?[A-Za-z_][A-Za-z_0-9]*\}?)\s*\]/ },
  { name: 'negative array slice offset ${a[@]: -1} (4.2)', re: /\$\{[A-Za-z_][A-Za-z_0-9]*\[[@*]\]:\s*-[0-9]/ },
  { name: 'namerefs: declare/local -n (4.3)', re: /\b(declare|local|typeset)\s+-[a-zA-Z]*n\b/ },
  { name: 'wait -n (4.3)', re: /(^|[\s;&|(])wait\s+-[a-zA-Z]*n/ },
  { name: '[[ -v var ]] (4.2)', re: /\[\[\s+-v\s/ },
  { name: 'fractional read -t (4.0)', re: /\bread\b[^\n]*\s-t\s*[0-9]*\.[0-9]/ },
  { name: '$BASHPID $EPOCHSECONDS $EPOCHREALTIME $SRANDOM (4.0 to 5.1)', re: /\$\{?(BASHPID|EPOCHSECONDS|EPOCHREALTIME|SRANDOM)\b/ },
  { name: '${v@Q} transformation (4.4)', re: /\$\{[A-Za-z_][A-Za-z_0-9]*@[QEPAa]\}/ },
]

/** Workstation-only scripts that need a newer bash than macOS ships, with why. */
const ALLOWED: Readonly<Record<string, string>> = {
  'run-all-checks.sh': 'the pre-push orchestrator: associative arrays and `wait -n -p` need bash 5.1, which a macOS contributor installs (brew install bash) before the hook runs',
  'wsl-test.sh': 'drives wsl.exe, which exists on Windows only, where Git for Windows ships bash 5',
}

/** The line up to its first comment: a `#` that opens a word outside single and double quotes. A `#` inside quotes, after a backslash, or in `${#a[@]}` and `$#` is not a comment and stays. Quotes are tracked per line, so a string that spans lines can leave a later comment in place, which only adds a flag. Quoted text is kept whole: an expansion inside double quotes is code. */
function stripComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i)
    if (quote === "'") {
      if (c === "'") quote = ''
    } else if (c === '\\') {
      i++
    } else if (quote === '"') {
      if (c === '"') quote = ''
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
      return line.slice(0, i)
    }
  }
  return line
}

function code(text: string): string[] {
  return text.split('\n').map(stripComment)
}

/** Every flagged construct in a script's text, as `line N: <name>`. */
function bash4Uses(text: string): string[] {
  const found: string[] = []
  code(text).forEach((line, i) => {
    for (const { name, re } of BASH4_ONLY) if (re.test(line)) found.push(`line ${i + 1}: ${name}`)
  })
  return found
}

const scripts = pinnedPopulation({ what: '.lefthook-scripts shell scripts', items: readdirSync(DIR).filter((f) => f.endsWith('.sh')), floor: 8, mustInclude: ['run-test.sh', 'prepush-focus.sh', 'wsl-gate.sh', 'run-all-checks.sh'] })

describe('the matchers see each bash-4 construct and spare bash-3.2 code', () => {
  const bad: ReadonlyArray<[string, string]> = [
    ['mapfile -t a <f', 'mapfile'],
    ['  readarray -t a < <(ls)', 'mapfile'],
    ['declare -A m=()', 'associative'],
    ['local -A m', 'associative'],
    ['echo "${name,,}"', 'case-changing'],
    ['x=${name^^}', 'case-changing'],
    ['  a) one ;&', 'fallthrough'],
    ['cmd |& tee log', 'pipe stderr'],
    ['echo "${arr[-1]}"', 'negative'],
    ['wait -n -p fin "$pid"', 'wait -n'],
    ['[[ -v name ]]', '-v var'],
    ['read -t 0.5 line', 'fractional'],
    ['readonly -A m', 'associative'],
    ['declare -g total=0', 'global declaration'],
    ['  local -g total', 'global declaration'],
    ['typeset -g total', 'global declaration'],
    ['shopt -s globstar', 'shopt'],
    ['shopt -s lastpipe', 'shopt'],
    ["printf '%(%Y-%m-%d)T\\n' -1", 'printf time format'],
    ['exec {fd}<file', 'fd-variable'],
    ['cmd {out}>log', 'fd-variable'],
    ['cmd {out}>>log', 'fd-variable'],
    ['read -N 4 chunk', 'read -N'],
    ['read -rN4 chunk', 'read -N'],
    ['x=${a[-1]}', 'negative array subscript'],
    ['a[-2]=x', 'negative array subscript'],
    ['x=${a[-$n]}', 'negative array subscript'],
    ['echo "${a[@]: -1}"', 'negative array slice'],
    // a # inside quotes opens no comment, so what follows it is still code
    ['echo "x #" ; mapfile -t a', 'mapfile'],
    ["echo 'x #' ; mapfile -t a", 'mapfile'],
    ['echo "a \\" # b" ; mapfile -t a', 'mapfile'],
    ['echo "${#a[@]}" ; mapfile -t a', 'mapfile'],
    ['echo $# ; mapfile -t a', 'mapfile'],
  ]
  for (const [snippet, name] of bad) {
    it(`flags ${JSON.stringify(snippet)}`, () => {
      expect(bash4Uses(snippet).join('\n')).toContain(name)
    })
  }

  const good = ['while IFS= read -r l || [[ -n "$l" ]]; do a+=("$l"); done <f', 'n=${#a[@]}; echo "$#"', 'echo ${a[@]+"${a[@]}"}', 'x=1 # mapfile -t a is bash 4', '# declare -A m', 'shopt -s nocasematch', 'printf "%s\\n" "${a[0]}" | sort -u', 'cmd 2>&1 | tee log', 'wait "$pid"', 'read -r -t 5 line', 'x=${s: -1}', 'local -a arr', 'local -r name=1', 'shopt -s nullglob', "printf '%s %s\\n' a b", 'echo "${x}">log', 'echo ${x}>log', 'read -r line < <(ls)', 'if [ "$n" -gt 1 ]; then :; fi', 'a[0]=x; echo "$((n-1))"', 'echo "x #mapfile"', 'echo "a # b" | sort -u', "echo '#' | sort -u", 'echo "x" # mapfile -t a', 'echo "it" ; echo done # shopt -s globstar']
  for (const snippet of good) {
    it(`spares ${JSON.stringify(snippet)}`, () => {
      expect(bash4Uses(snippet)).toEqual([])
    })
  }
})

describe('.lefthook-scripts', () => {
  it('has scripts to check', () => {
    expect(scripts).toContain('run-test.sh')
    expect(scripts).toContain('prepush-focus.sh')
    expect(scripts).toContain('wsl-gate.sh')
  })

  for (const script of scripts.filter((f) => !(f in ALLOWED))) {
    it(`${script} uses nothing bash 3.2 lacks`, () => {
      expect(bash4Uses(readFileSync(path.join(DIR, script), 'utf8'))).toEqual([])
    })
  }

  for (const script of Object.keys(ALLOWED)) {
    it(`${script} still needs the newer bash that ALLOWED records for it`, () => {
      expect(scripts).toContain(script)
      expect(bash4Uses(readFileSync(path.join(DIR, script), 'utf8')).length).toBeGreaterThan(0)
    })
  }
})

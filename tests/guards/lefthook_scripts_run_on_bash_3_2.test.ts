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
  { name: 'associative array: declare/local/typeset -A (4.0)', re: /\b(declare|local|typeset)\s+-[a-zA-Z]*A/ },
  { name: 'case-changing expansion ${v,,} ${v^^} (4.0)', re: /\$\{[A-Za-z_][A-Za-z_0-9]*(,,?|\^\^?)[^}]*\}/ },
  { name: 'case fallthrough ;& ;;& (4.0)', re: /;;?&(?!&)/ },
  { name: 'pipe stderr |& (4.0)', re: /\|&/ },
  { name: 'append both streams &>> (4.0)', re: /&>>/ },
  { name: 'coproc (4.0)', re: /(^|[\s;&|(])coproc(\s|$)/ },
  { name: 'negative array subscript (4.3)', re: /\[-[0-9]+\]/ },
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

/** Drops whole-line comments and the trailing `# ...` of a line, so prose that names a builtin is not a use of it. A `#` inside `${#a[@]}`, `$#` or a word is not preceded by whitespace and stays. */
function code(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '$1'))
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
  ]
  for (const [snippet, name] of bad) {
    it(`flags ${JSON.stringify(snippet)}`, () => {
      expect(bash4Uses(snippet).join('\n')).toContain(name)
    })
  }

  const good = ['while IFS= read -r l || [[ -n "$l" ]]; do a+=("$l"); done <f', 'n=${#a[@]}; echo "$#"', 'echo ${a[@]+"${a[@]}"}', 'x=1 # mapfile -t a is bash 4', '# declare -A m', 'shopt -s nocasematch', 'printf "%s\\n" "${a[0]}" | sort -u', 'cmd 2>&1 | tee log', 'wait "$pid"', 'read -r -t 5 line']
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

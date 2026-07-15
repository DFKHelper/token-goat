// Batch B golden tests — package-manager filters. Faithfully ported from the Python suites (py_test_pkgmgr.py and the relevant TestXxx classes in test_bash_compress.py). These are the regression spec for the 15 filters in src/tool_filters/package_managers.ts.

import { describe, expect, it } from 'vitest'

import { PACKAGE_MANAGER_FILTERS, detectFromCommand, selectFilter, TOOL_FILTERS } from '../src/tool_filters/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const filterByName = (name: string) => {
  const f = TOOL_FILTERS.find((x) => x.name === name) ?? PACKAGE_MANAGER_FILTERS.find((x) => x.name === name)
  if (!f) throw new Error(`Filter not found: ${name}`)
  return f
}

const npmInstallFilter = filterByName('npm_install')
const pnpmFilter = filterByName('pnpm')
const yarnFilter = filterByName('yarn')
const pipFilter = filterByName('pip')
const uvFilter = filterByName('uv')
const condaFilter = filterByName('conda')
const gemFilter = filterByName('gem')
const bundlerFilter = filterByName('bundler')
const composerFilter = filterByName('composer')
const nugetFilter = filterByName('nuget')
const pubFilter = filterByName('pub')
const conanFilter = filterByName('conan')
const vcpkgFilter = filterByName('vcpkg')
const npmFilter = filterByName('npm')
const depListFilter = filterByName('dep-list')

// ---------------------------------------------------------------------------
// PACKAGE_MANAGER_FILTERS array
// ---------------------------------------------------------------------------

describe('PACKAGE_MANAGER_FILTERS', () => {
  it('exports 15 filter entries', () => {
    expect(PACKAGE_MANAGER_FILTERS).toHaveLength(15)
  })

  it('all filters are registered in TOOL_FILTERS', () => {
    for (const f of PACKAGE_MANAGER_FILTERS) {
      expect(TOOL_FILTERS).toContain(f)
    }
  })
})

// ---------------------------------------------------------------------------
// NpmInstallFilter
// ---------------------------------------------------------------------------

describe('NpmInstallFilter (npm path)', () => {
  it('matches npm install', () => {
    expect(npmInstallFilter.matches(['npm', 'install'])).toBe(true)
  })

  it('matches npm i', () => {
    expect(npmInstallFilter.matches(['npm', 'i'])).toBe(true)
  })

  it('matches npm ci', () => {
    expect(npmInstallFilter.matches(['npm', 'ci'])).toBe(true)
  })

  it('does not match npm run', () => {
    expect(npmInstallFilter.matches(['npm', 'run', 'build'])).toBe(false)
  })

  it('drops verbose/timing/sill lines', () => {
    const stdout = [
      'npm timing stage:runTopLevelLifecycles Completed in 1000ms',
      'npm sill install loadCurrentTree',
      'npm http fetch GET 200 https://registry.npmjs.org/foo',
      'npm verb addRemoteGit',
      'added 10 packages in 3s',
    ].join('\n')
    const result = npmInstallFilter.apply(stdout, '', 0, ['npm', 'install'])
    expect(result.text).toContain('added 10 packages')
    expect(result.text).not.toContain('timing stage')
    expect(result.text).not.toContain('npm sill')
    expect(result.text).not.toContain('npm http fetch')
  })

  it('keeps first 3 deprecated warnings and emits suppressed count for more', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `npm warn deprecated pkg${i}@1.0.0: old`)
    const result = npmInstallFilter.apply(lines.join('\n'), '', 0, ['npm', 'install'])
    expect(result.text).toContain('npm warn deprecated pkg0')
    expect(result.text).toContain('npm warn deprecated pkg2')
    expect(result.text).not.toContain('npm warn deprecated pkg3')
    expect(result.text).toMatch(/suppressed.+3.+deprecated/i)
  })

  it('keeps first 3 npm warn lines and emits suppressed count for more', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `npm warn ERESOLVE pkg${i} conflict`)
    const result = npmInstallFilter.apply(lines.join('\n'), '', 0, ['npm', 'install'])
    expect(result.text).toContain('npm warn ERESOLVE pkg0')
    expect(result.text).not.toContain('npm warn ERESOLVE pkg3')
    expect(result.text).toMatch(/suppressed.+2.+warn/i)
  })

  it('drops "found 0 vulnerabilities" and funding noise', () => {
    const stdout = [
      'added 42 packages in 1s',
      'found 0 vulnerabilities',
      '10 packages are looking for funding',
      '  run `npm fund` for details',
    ].join('\n')
    const result = npmInstallFilter.apply(stdout, '', 0, ['npm', 'install'])
    expect(result.text).toContain('added 42')
    expect(result.text).not.toContain('found 0 vulnerabilities')
    expect(result.text).not.toContain('looking for funding')
    expect(result.text).not.toContain('run `npm fund`')
  })

  it('keeps npm notice lines that mention lock', () => {
    const stdout = [
      'npm notice created a lockfile as package-lock.json',
      'npm notice foo bar notice',
    ].join('\n')
    const result = npmInstallFilter.apply(stdout, '', 0, ['npm', 'install'])
    expect(result.text).toContain('lockfile')
    expect(result.text).not.toContain('npm notice foo bar')
  })
})

describe('NpmInstallFilter (yarn path)', () => {
  it('matches yarn install', () => {
    expect(npmInstallFilter.matches(['yarn', 'install'])).toBe(true)
  })

  it('matches yarn add', () => {
    expect(npmInstallFilter.matches(['yarn', 'add', 'lodash'])).toBe(true)
  })

  it('drops peer dep warnings, phase headers, info lines', () => {
    const stdout = [
      'yarn install v1.22',
      'warning "foo > bar" has unmet peer dependency react@^18',
      '[1/4] Resolving packages...',
      '[2/4] Fetching packages...',
      'info There appears to be trouble',
      'success Saved lockfile',
    ].join('\n')
    const result = npmInstallFilter.apply(stdout, '', 0, ['yarn', 'install'])
    expect(result.text).not.toContain('unmet peer dependency')
    expect(result.text).not.toContain('[1/4]')
    expect(result.text).not.toContain('info There appears')
    expect(result.text).not.toContain('success Saved')
    expect(result.text).toMatch(/suppressed/i)
  })
})

describe('NpmInstallFilter (pnpm path)', () => {
  it('matches pnpm install', () => {
    expect(npmInstallFilter.matches(['pnpm', 'install'])).toBe(true)
  })

  it('drops +++ bars and non-done Progress lines', () => {
    const stdout = [
      'Packages: +5',
      '+++++++++++++++++++',
      'Progress: resolved 5, reused 0, downloaded 5, added 5',
      'Progress: done',
      'added 5 packages in 1s',
    ].join('\n')
    const result = npmInstallFilter.apply(stdout, '', 0, ['pnpm', 'install'])
    expect(result.text).not.toContain('++++++++')
    // the "done" progress line is kept
    expect(result.text).toContain('Progress: done')
    expect(result.text).toContain('added 5 packages')
  })
})

// ---------------------------------------------------------------------------
// PnpmFilter
// ---------------------------------------------------------------------------

describe('PnpmFilter', () => {
  it('matches pnpm install', () => {
    expect(pnpmFilter.matches(['pnpm', 'install'])).toBe(true)
  })

  it('matches pnpm add', () => {
    expect(pnpmFilter.matches(['pnpm', 'add', 'express'])).toBe(true)
  })

  it('matches pnpm.exe via stem', () => {
    expect(pnpmFilter.matches(['pnpm.exe', 'install'])).toBe(true)
  })

  it('does not match npm', () => {
    expect(pnpmFilter.matches(['npm', 'install'])).toBe(false)
  })

  it('keeps Packages: summary and Already up to date', () => {
    const stdout = [
      'Packages: +42',
      '++++++++++++++++++++++++++++++++',
      'Progress: resolved 42, reused 38, downloaded 4, added 42, done',
      '',
      'Done in 3.5s',
    ].join('\n')
    const result = pnpmFilter.apply(stdout, '', 0, ['pnpm', 'install'])
    expect(result.text).toContain('Packages:')
    expect(result.text).toContain('Done in 3.5s')
  })

  it('collapses resolver/download progress lines', () => {
    const stdout = [
      'Packages: +10',
      'Progress: resolved 10, done',
      'Resolving: 5/10',
      'Resolving: 10/10',
      'Downloading: 3/10',
      'Downloading: 10/10',
      'Done in 2s',
    ].join('\n')
    const result = pnpmFilter.apply(stdout, '', 0, ['pnpm', 'install'])
    expect(result.text).not.toContain('Resolving: 5/10')
    expect(result.text).toMatch(/collapsed/i)
  })

  it('keeps error lines', () => {
    const stdout = 'Packages: +5\n\nERR! ENOENT missing package.json\n'
    const result = pnpmFilter.apply(stdout, '', 1, ['pnpm', 'install'])
    expect(result.text).toContain('ERR!')
  })

  it('keeps Lockfile lines', () => {
    const stdout = 'Packages: +5\nLockfile is up to date, resolution step is skipped\nDone in 1s\n'
    const result = pnpmFilter.apply(stdout, '', 0, ['pnpm', 'install'])
    expect(result.text).toContain('Lockfile')
  })

  it('prepends "pnpm run <script>:" label on run', () => {
    const out = 'vite v4.5.0\nServer running at http://localhost:5173\n'
    const result = pnpmFilter.apply(out, '', 0, ['pnpm', 'run', 'dev'])
    expect(result.text).toContain('pnpm run dev:')
    expect(result.text).toContain('Server running')
  })

  it('passes exec output through unchanged', () => {
    const out = 'src/index.ts:10:1 error  Parsing error: Unexpected token\n'
    const result = pnpmFilter.apply(out, '', 1, ['pnpm', 'exec', 'eslint', 'src/'])
    expect(result.text).toContain('Parsing error')
    expect(result.text).not.toMatch(/collapsed/i)
  })

  it('passes dlx output through unchanged', () => {
    const out = 'create-react-app my-app\nSuccess! Created my-app\n'
    const result = pnpmFilter.apply(out, '', 0, ['pnpm', 'dlx', 'create-react-app', 'my-app'])
    expect(result.text).toContain('Success! Created my-app')
  })
})

// ---------------------------------------------------------------------------
// YarnFilter
// ---------------------------------------------------------------------------

describe('YarnFilter', () => {
  it('matches yarn install', () => {
    expect(yarnFilter.matches(['yarn', 'install'])).toBe(true)
  })

  it('matches yarn (bare)', () => {
    expect(yarnFilter.matches(['yarn'])).toBe(true)
  })

  it('does not match pnpm', () => {
    expect(yarnFilter.matches(['pnpm', 'install'])).toBe(false)
  })
})

describe('YarnFilter classic (v1)', () => {
  const CLASSIC_OUTPUT = [
    'yarn install v1.22.19',
    '[1/4] Resolving packages...',
    '[2/4] Fetching packages...',
    '  Fetching lodash@4.17.21',
    '  Fetching express@4.18.2',
    '  Fetching mime@1.6.0',
    '[3/4] Linking dependencies...',
    '[4/4] Building fresh packages...',
    'Done in 12.34s.',
  ].join('\n')

  it('keeps banner line', () => {
    const result = yarnFilter.apply(CLASSIC_OUTPUT, '', 0, ['yarn', 'install'])
    expect(result.text).toContain('yarn install v1.22.19')
  })

  it('keeps phase headers', () => {
    const result = yarnFilter.apply(CLASSIC_OUTPUT, '', 0, ['yarn', 'install'])
    expect(result.text).toContain('[1/4] Resolving packages')
    expect(result.text).toContain('[3/4] Linking dependencies')
    expect(result.text).toContain('[2/4] Fetching packages')
  })

  it('collapses individual fetch lines inside [2/4] phase', () => {
    const result = yarnFilter.apply(CLASSIC_OUTPUT, '', 0, ['yarn', 'install'])
    expect(result.text).not.toContain('Fetching lodash@4.17.21')
    expect(result.text).toMatch(/collapsed.+fetch/i)
  })

  it('keeps Done line', () => {
    const result = yarnFilter.apply(CLASSIC_OUTPUT, '', 0, ['yarn', 'install'])
    expect(result.text).toContain('Done in 12.34s')
  })

  it('deduplicates exact-repeat warning lines', () => {
    const out = [
      'yarn install v1.22.19',
      'warning lodash@4.17.21: This package is deprecated',
      'warning lodash@4.17.21: This package is deprecated',
      'warning lodash@4.17.21: This package is deprecated',
      'Done in 1s.',
    ].join('\n')
    const result = yarnFilter.apply(out, '', 0, ['yarn', 'install'])
    expect(result.text).toContain('warning lodash')
    expect(result.text.split('warning lodash').length - 1).toBe(1)
    expect(result.text).toMatch(/deduplicated/i)
  })

  // Regression: the dedup key truncated each warning line to its first 60 characters, so two
  // distinct warnings sharing a long common leading substring (e.g. the same package name in
  // two different peer-dependency warnings) collided and one was silently dropped as a false
  // "repeat".
  it('does not drop a distinct warning that shares a long common prefix with another', () => {
    const out = [
      'yarn install v1.22.19',
      'warning "@some-very-long-scope/really-long-package-name-x > child@1.0.0" has unmet peer dependency "react@^16.0.0".',
      'warning "@some-very-long-scope/really-long-package-name-x > child@1.0.0" has unmet peer dependency "react-dom@^16.0.0".',
      'Done in 1s.',
    ].join('\n')
    const result = yarnFilter.apply(out, '', 0, ['yarn', 'install'])
    expect(result.text).toContain('react@^16.0.0')
    expect(result.text).toContain('react-dom@^16.0.0')
  })

  it('keeps error lines', () => {
    const out = CLASSIC_OUTPUT + '\nerror Command failed with exit code 1.'
    const result = yarnFilter.apply(out, '', 1, ['yarn', 'install'])
    expect(result.text).toContain('error Command failed')
  })
})

describe('YarnFilter berry (v2+)', () => {
  const BERRY_OUTPUT = [
    '➤ YN0000: · Yarn 3.6.3',
    '➤ YN0000: ┌ Resolution step',
    '➤ YN0032: │ lodash@npm:4.17.21 can be deduped...',
    '➤ YN0000: └ Completed in 0.42s',
    '➤ YN0000: ┌ Fetch step',
    '➤ YN0013: │ lodash@npm:4.17.21 fetched 100KB 1/3',
    '➤ YN0013: │ express@npm:4.18.2 fetched 200KB 2/3',
    '➤ YN0013: │ mime@npm:1.6.0 fetched 10KB 3/3',
    '➤ YN0000: └ Completed in 2.1s',
    '➤ YN0000: ┌ Link step',
    '➤ YN0000: └ Completed',
    '➤ YN0000: · Done in 3.5s',
  ].join('\n')

  it('keeps Done line', () => {
    const result = yarnFilter.apply(BERRY_OUTPUT, '', 0, ['yarn', 'install'])
    expect(result.text).toContain('Done in 3.5s')
  })

  it('keeps Resolution step header', () => {
    const result = yarnFilter.apply(BERRY_OUTPUT, '', 0, ['yarn', 'install'])
    expect(result.text).toContain('Resolution step')
  })

  it('collapses per-package fetch progress lines', () => {
    const result = yarnFilter.apply(BERRY_OUTPUT, '', 0, ['yarn', 'install'])
    expect(result.text).toMatch(/collapsed/i)
    expect(result.text).not.toContain('lodash@npm:4.17.21 fetched 100KB')
  })

  it('keeps YN0001 error lines', () => {
    const out = BERRY_OUTPUT + '\n➤ YN0001: · Error: something went wrong'
    const result = yarnFilter.apply(out, '', 1, ['yarn', 'install'])
    expect(result.text).toContain('YN0001')
  })
})

// ---------------------------------------------------------------------------
// PipFilter
// ---------------------------------------------------------------------------

describe('PipFilter', () => {
  it('matches pip install', () => {
    expect(pipFilter.matches(['pip', 'install', 'requests'])).toBe(true)
  })

  it('matches pip3 install', () => {
    expect(pipFilter.matches(['pip3', 'install', 'numpy'])).toBe(true)
  })

  it('drops Downloading / Using cached lines', () => {
    const stdout = [
      'Collecting requests',
      '  Downloading requests-2.31.0-py3-none-any.whl (62 kB)',
      '  Using cached requests-2.31.0-py3-none-any.whl',
      '  Downloading certifi-2024.2.2-py3-none-any.whl (163 kB)',
      'Installing collected packages: certifi, requests',
      'Successfully installed certifi-2024.2.2 requests-2.31.0',
    ].join('\n')
    const result = pipFilter.apply(stdout, '', 0, ['pip', 'install', 'requests'])
    expect(result.text).toContain('Successfully installed')
    expect(result.text).not.toContain('Downloading requests-2.31.0')
    expect(result.text).not.toContain('Using cached')
    expect(result.text).toMatch(/dropped.+download/i)
  })

  it('drops build-wheel and metadata noise', () => {
    const stdout = [
      'Collecting foobar',
      '  Building wheel for foobar (pyproject.toml)',
      '  Created wheel for foobar',
      '  Stored in directory: /tmp/pip-...',
      '  Preparing metadata (pyproject.toml)',
      'Installing collected packages: foobar',
      'Successfully installed foobar-1.0',
    ].join('\n')
    const result = pipFilter.apply(stdout, '', 0, ['pip', 'install', 'foobar'])
    expect(result.text).toContain('Successfully installed')
    expect(result.text).not.toContain('Building wheel')
    expect(result.text).not.toContain('Preparing metadata')
  })

  it('caps Collecting lines at 5', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Collecting pkg${i}`)
    const stdout = lines.join('\n') + '\nSuccessfully installed pkg0 pkg1 pkg2 pkg3 pkg4 pkg5 pkg6 pkg7 pkg8 pkg9'
    const result = pipFilter.apply(stdout, '', 0, ['pip', 'install', 'pkg0'])
    expect(result.text).toContain('Collecting pkg0')
    expect(result.text).toContain('Collecting pkg4')
    expect(result.text).not.toContain('Collecting pkg5')
    expect(result.text).toMatch(/more.*Collecting/i)
  })

  it('drops pip>=22 progress bar lines (━)', () => {
    const stdout = [
      'Collecting requests',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100.0/100.0 kB 1.2 MB/s eta 0:00:00',
      'Successfully installed requests-2.31.0',
    ].join('\n')
    const result = pipFilter.apply(stdout, '', 0, ['pip', 'install', 'requests'])
    expect(result.text).not.toContain('━')
    expect(result.text).toContain('Successfully installed')
  })

  it('preserves error lines', () => {
    const stdout = [
      'Collecting nonexistent-package',
      'ERROR: Could not find a version that satisfies the requirement nonexistent-package',
    ].join('\n')
    const result = pipFilter.apply(stdout, '', 1, ['pip', 'install', 'nonexistent-package'])
    expect(result.text).toContain('ERROR: Could not find')
  })

  // Regression: pip list/freeze dispatch to PipFilter (it precedes DepListFilter
  // in dispatch order), but PipFilter had no truncation logic of its own -- a
  // long `pip freeze` passed straight through the generic install-noise
  // stripper unchanged, since none of its patterns match plain package lines.
  it('pip freeze ≤50 packages: passthrough', () => {
    const out = Array.from({ length: 40 }, (_, i) => `package-${i}==1.${i}`).join('\n')
    const result = pipFilter.apply(out, '', 0, ['pip', 'freeze'])
    expect(result.text).toContain('package-0==')
    expect(result.text).toContain('package-39==')
    expect(result.text).not.toMatch(/collapsed \d+ package lines/)
  })

  it('pip freeze 60 packages: first 20 shown, rest collapsed', () => {
    const out = Array.from({ length: 60 }, (_, i) => `package-${i}==1.${i}`).join('\n')
    const result = pipFilter.apply(out, '', 0, ['pip', 'freeze'])
    expect(result.text).toContain('package-0==')
    expect(result.text).toContain('package-19==')
    expect(result.text).not.toContain('package-20==')
    expect(result.text).toContain('collapsed 40 package lines')
  })

  it('pip list 60 packages: first 20 shown, rest collapsed', () => {
    const out = Array.from({ length: 60 }, (_, i) => `package-${i}==1.${i}`).join('\n')
    const result = pipFilter.apply(out, '', 0, ['pip', 'list'])
    expect(result.text).toContain('package-0==')
    expect(result.text).toContain('package-19==')
    expect(result.text).not.toContain('package-20==')
    expect(result.text).toContain('collapsed 40 package lines')
  })
})

// ---------------------------------------------------------------------------
// UvFilter
// ---------------------------------------------------------------------------

describe('UvFilter', () => {
  it('matches uv sync', () => {
    expect(uvFilter.matches(['uv', 'sync'])).toBe(true)
  })

  it('matches uv add', () => {
    expect(uvFilter.matches(['uv', 'add', 'requests'])).toBe(true)
  })

  it('matches uv pip freeze', () => {
    expect(uvFilter.matches(['uv', 'pip', 'freeze'])).toBe(true)
  })

  it('matches uv pip list', () => {
    expect(uvFilter.matches(['uv', 'pip', 'list'])).toBe(true)
  })

  it('matches uv tool install', () => {
    expect(uvFilter.matches(['uv', 'tool', 'install', 'ruff'])).toBe(true)
  })

  it('does not match uv run', () => {
    expect(uvFilter.matches(['uv', 'run', 'pytest'])).toBe(false)
  })

  it('drops Downloading/Downloaded/Fetching progress lines', () => {
    const stdout = [
      'Resolved 5 packages in 123ms',
      '  Downloaded requests 2.31.0 (96 KB)',
      '  Downloading certifi 2024.2.2 (164 KB)',
      '  Fetching metadata for urllib3',
      'Installed 5 packages in 0.5s',
    ].join('\n')
    const result = uvFilter.apply(stdout, '', 0, ['uv', 'sync'])
    expect(result.text).toContain('Resolved 5 packages')
    expect(result.text).toContain('Installed 5 packages')
    expect(result.text).not.toContain('Downloaded requests')
    expect(result.text).not.toContain('Downloading certifi')
    expect(result.text).not.toContain('Fetching metadata')
  })

  it('drops per-package +/- diff lines', () => {
    const stdout = [
      'Resolved 10 packages in 500ms',
      '  + serde==1.0.197',
      '  - tokio==1.35.0',
      '  + tokio==1.36.0',
      'Installed 3 packages in 1.2s',
    ].join('\n')
    const result = uvFilter.apply(stdout, '', 0, ['uv', 'add', 'tokio'])
    expect(result.text).not.toContain('  + serde')
    expect(result.text).not.toContain('  - tokio')
    expect(result.text).toMatch(/dropped.+diff/i)
  })

  it('uv pip freeze ≤50 packages: passthrough', () => {
    const out = Array.from({ length: 30 }, (_, i) => `package-${i}==1.${i}`).join('\n')
    const result = uvFilter.apply(out, '', 0, ['uv', 'pip', 'freeze'])
    for (let i = 0; i < 30; i++) expect(result.text).toContain(`package-${i}==`)
  })

  it('uv pip freeze 51 packages: first 20 shown, rest collapsed', () => {
    const out = Array.from({ length: 51 }, (_, i) => `package-${i}==1.${i}`).join('\n')
    const result = uvFilter.apply(out, '', 0, ['uv', 'pip', 'freeze'])
    expect(result.text).toContain('package-0==')
    expect(result.text).toContain('package-19==')
    expect(result.text).not.toContain('package-20==')
    expect(result.text).toContain('31')
    expect(result.text).toMatch(/package/i)
  })

  it('uv pip list 60 packages: first 20 + count', () => {
    const out = Array.from({ length: 60 }, (_, i) => `package-${i}==1.${i}`).join('\n')
    const result = uvFilter.apply(out, '', 0, ['uv', 'pip', 'list'])
    expect(result.text).toContain('package-0==')
    expect(result.text).toContain('package-19==')
    expect(result.text).not.toContain('package-20==')
    expect(result.text).toContain('40')
  })
})

// ---------------------------------------------------------------------------
// CondaFilter
// ---------------------------------------------------------------------------

describe('CondaFilter', () => {
  it('matches conda install', () => {
    expect(condaFilter.matches(['conda', 'install', 'numpy'])).toBe(true)
  })

  it('matches conda create', () => {
    expect(condaFilter.matches(['conda', 'create', '-n', 'myenv', 'python=3.11'])).toBe(true)
  })

  it('matches conda list', () => {
    expect(condaFilter.matches(['conda', 'list'])).toBe(true)
  })

  it('matches conda env export', () => {
    expect(condaFilter.matches(['conda', 'env', 'export'])).toBe(true)
  })

  it('matches mamba', () => {
    expect(condaFilter.matches(['mamba', 'install', 'scipy'])).toBe(true)
  })

  it('matches micromamba', () => {
    expect(condaFilter.matches(['micromamba', 'install', 'pandas'])).toBe(true)
  })

  it('does not match pip', () => {
    expect(condaFilter.matches(['pip', 'install', 'numpy'])).toBe(false)
  })
})

describe('CondaFilter install', () => {
  const INSTALL_OUTPUT = [
    'Collecting package metadata (current_repodata.json): done',
    'Solving environment: done',
    '',
    '## Package Plan ##',
    '',
    '  environment location: /opt/conda',
    '',
    'The following packages will be downloaded:',
    '',
    'Downloading and Extracting Packages:',
    'numpy-1.24.0         | 10 MB | ############ | 100%',
    'blas-1.0             | 6 KB  | ############ | 100%',
    '',
    'Preparing transaction: done',
    'Verifying transaction: done',
    'Executing transaction: done',
  ].join('\n')

  it('keeps phase header lines', () => {
    const result = condaFilter.apply(INSTALL_OUTPUT, '', 0, ['conda', 'install', 'numpy'])
    expect(result.text).toContain('Collecting package metadata')
    expect(result.text).toContain('Solving environment')
    expect(result.text).toContain('Preparing transaction')
    expect(result.text).toContain('Executing transaction')
  })

  it('collapses download progress lines', () => {
    const result = condaFilter.apply(INSTALL_OUTPUT, '', 0, ['conda', 'install', 'numpy'])
    expect(result.text).toMatch(/collapsed/i)
  })

  it('preserves error lines', () => {
    const out = INSTALL_OUTPUT + '\nCondaError: package not found'
    const result = condaFilter.apply(out, '', 1, ['conda', 'install', 'numpy'])
    expect(result.text).toContain('CondaError')
  })

  it('collapses package install lines (  - pkg ver)', () => {
    const stdout = [
      'Solving environment: done',
      'Preparing transaction: done',
      '  - numpy 1.24.0 py311 0',
      '  - mkl 2023.1 0',
      '  - blas 1.0 0',
      'Executing transaction: done',
    ].join('\n')
    const result = condaFilter.apply(stdout, '', 0, ['conda', 'install', 'numpy'])
    expect(result.text).toContain('collapsed 3 package install lines')
    expect(result.text).not.toContain('  - numpy')
  })
})

describe('CondaFilter list', () => {
  const makeListOutput = (n: number) =>
    ['# packages in environment at /opt/conda:', '# Name                    Version']
      .concat(Array.from({ length: n }, (_, i) => `package-${String(i).padStart(3, '0')}            1.${i}           py311`))
      .join('\n')

  it('passes through ≤50 packages', () => {
    const result = condaFilter.apply(makeListOutput(30), '', 0, ['conda', 'list'])
    expect(result.text).toContain('package-000')
    expect(result.text).toContain('package-029')
  })

  it('truncates at 20 when >50 packages, emits count', () => {
    const result = condaFilter.apply(makeListOutput(60), '', 0, ['conda', 'list'])
    expect(result.text).toContain('package-000')
    expect(result.text).toContain('package-019')
    expect(result.text).not.toContain('package-020')
    expect(result.text).toContain('40 more packages')
  })

  it('preserves header comment lines', () => {
    const result = condaFilter.apply(makeListOutput(60), '', 0, ['conda', 'list'])
    expect(result.text).toContain('# packages in environment')
  })
})

describe('CondaFilter env export', () => {
  const makeExport = (n: number) =>
    ['name: myenv', 'channels:', '  - defaults', 'dependencies:']
      .concat(Array.from({ length: n }, (_, i) => `  - package-${i}=1.${i}=py311`))
      .concat(['prefix: /opt/conda/envs/myenv'])
      .join('\n')

  it('passes through ≤50 deps', () => {
    const result = condaFilter.apply(makeExport(30), '', 0, ['conda', 'env', 'export'])
    expect(result.text).toContain('package-0')
    expect(result.text).toContain('package-29')
  })

  it('truncates at 20 when >50 deps, emits count', () => {
    const result = condaFilter.apply(makeExport(60), '', 0, ['conda', 'env', 'export'])
    expect(result.text).toContain('  - package-0')
    expect(result.text).toContain('  - package-19')
    expect(result.text).not.toContain('  - package-20')
    expect(result.text).toContain('40 more dependencies')
  })
})

// ---------------------------------------------------------------------------
// GemFilter
// ---------------------------------------------------------------------------

describe('GemFilter', () => {
  it('matches gem install', () => {
    expect(gemFilter.matches(['gem', 'install', 'rails'])).toBe(true)
  })

  it('drops Fetching lines', () => {
    const stdout = [
      'Fetching rails-7.1.2.gem',
      'Fetching activesupport-7.1.2.gem',
      'Successfully installed rails-7.1.2',
      '1 gem installed',
    ].join('\n')
    const result = gemFilter.apply(stdout, '', 0, ['gem', 'install', 'rails'])
    expect(result.text).not.toContain('Fetching rails')
    expect(result.text).not.toContain('Fetching activesupport')
    expect(result.text).toMatch(/dropped.+Fetching/i)
  })

  it('drops documentation noise', () => {
    const stdout = [
      'Successfully installed rails-7.1.2',
      'Parsing documentation for rails-7.1.2',
      'Installing ri documentation for rails-7.1.2',
      'Done installing documentation for rails-7.1.2',
      '1 gem installed',
    ].join('\n')
    const result = gemFilter.apply(stdout, '', 0, ['gem', 'install', 'rails'])
    expect(result.text).not.toContain('Parsing documentation')
    expect(result.text).not.toContain('Installing ri documentation')
    expect(result.text).toMatch(/dropped.+documentation/i)
  })

  it('collapses >4 Successfully installed lines to head-2 + count + tail-1', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `Successfully installed gem${i}-1.0`)
    const stdout = lines.join('\n') + '\n6 gems installed'
    const result = gemFilter.apply(stdout, '', 0, ['gem', 'install', 'mygem'])
    expect(result.text).toContain('gem0')
    expect(result.text).toContain('gem1')
    expect(result.text).not.toContain('gem2')
    expect(result.text).toContain('gem5')
    expect(result.text).toContain('more installed')
  })

  it('keeps all 4 Successfully installed lines when ≤4', () => {
    const lines = Array.from({ length: 4 }, (_, i) => `Successfully installed gem${i}-1.0`)
    const result = gemFilter.apply(lines.join('\n'), '', 0, ['gem', 'install', 'mygem'])
    for (let i = 0; i < 4; i++) expect(result.text).toContain(`gem${i}`)
  })

  it('passes non-install subcommands through with token cap', () => {
    const out = Array.from({ length: 20 }, (_, i) => `gem-${i} (1.0.0)`).join('\n')
    const result = gemFilter.apply(out, '', 0, ['gem', 'list'])
    // capTokens 1000 — small output goes through
    expect(result.text).toContain('gem-0')
  })
})

// ---------------------------------------------------------------------------
// BundlerFilter (factory-based)
// ---------------------------------------------------------------------------

describe('BundlerFilter (makePackageManagerFilter factory)', () => {
  it('matches bundle', () => {
    expect(bundlerFilter.matches(['bundle', 'install'])).toBe(true)
  })

  it('matches bundler', () => {
    expect(bundlerFilter.matches(['bundler', 'install'])).toBe(true)
  })

  it('collapses Using gem lines', () => {
    const stdout = [
      'Using rake 13.0.6',
      'Using rails 7.1.2',
      'Using activesupport 7.1.2',
      'Bundle complete! 5 Gemfile dependencies, 42 gems now installed.',
    ].join('\n')
    const result = bundlerFilter.apply(stdout, '', 0, ['bundle', 'install'])
    expect(result.text).not.toContain('Using rake')
    expect(result.text).not.toContain('Using rails')
    expect(result.text).toContain("collapsed 3 'Using gem' lines")
    expect(result.text).toContain('Bundle complete!')
  })

  it('collapses Fetching/Installing gem lines', () => {
    const stdout = [
      'Fetching rails 7.1.2',
      'Installing rails 7.1.2',
      'Fetching activesupport 7.1.2',
      'Bundle complete! 1 Gemfile dependency, 10 gems now installed.',
    ].join('\n')
    const result = bundlerFilter.apply(stdout, '', 0, ['bundle', 'install'])
    expect(result.text).not.toContain('Fetching rails')
    expect(result.text).not.toContain('Installing rails')
    expect(result.text).toContain("collapsed 3 'Fetching/Installing gem' lines")
    expect(result.text).toContain('Bundle complete!')
  })

  it('preserves error lines', () => {
    const stdout = 'Fetching rails 7.1.2\nERROR: bundler: failed to load command\n'
    const result = bundlerFilter.apply(stdout, '', 1, ['bundle', 'install'])
    expect(result.text).toContain('ERROR: bundler')
  })
})

// ---------------------------------------------------------------------------
// ComposerFilter
// ---------------------------------------------------------------------------

describe('ComposerFilter', () => {
  it('matches composer install', () => {
    expect(composerFilter.matches(['composer', 'install'])).toBe(true)
  })

  it('matches composer.phar', () => {
    expect(composerFilter.matches(['composer.phar', 'install'])).toBe(true)
  })

  it('collapses install and download lines', () => {
    const stdout = [
      'Loading composer repositories with package information',
      'Updating dependencies',
      '  - Downloading vendor/pkg (1.2.3)',
      '  - Installing vendor/pkg (1.2.3): Extracting archive',
      '  - Downloading vendor/lib (2.0.0)',
      '  - Installing vendor/lib (2.0.0): Extracting archive',
      'Generating autoload files',
    ].join('\n')
    const result = composerFilter.apply(stdout, '', 0, ['composer', 'install'])
    expect(result.text).not.toContain('Downloading vendor/pkg')
    expect(result.text).not.toContain('Installing vendor/pkg')
    expect(result.text).toContain('collapsed 2 package install lines')
    expect(result.text).toContain('collapsed 2 package download lines')
    expect(result.text).toContain('Generating autoload files')
  })

  it('drops download-progress percentage lines', () => {
    const stdout = [
      '  - Downloading vendor/pkg (50%)',
      '  - Installing vendor/lib (100%)',
      'Writing lock file',
    ].join('\n')
    const result = composerFilter.apply(stdout, '', 0, ['composer', 'install'])
    expect(result.text).not.toContain('(50%)')
    expect(result.text).toContain('Writing lock file')
  })

  it('drops funding-notice lines', () => {
    const stdout = [
      'Package operations: 5 installs',
      '5 packages you are using are looking for funding',
      'Done',
    ].join('\n')
    const result = composerFilter.apply(stdout, '', 0, ['composer', 'install'])
    expect(result.text).not.toContain('looking for funding')
    expect(result.text).toContain('Done')
  })

  it('deduplicates warning lines', () => {
    const stdout = [
      '  Warning: deprecated usage',
      '  Warning: deprecated usage',
      '  Warning: deprecated usage',
      'Writing lock file',
    ].join('\n')
    const result = composerFilter.apply(stdout, '', 0, ['composer', 'install'])
    expect(result.text).toMatch(/deduplicated.+2.+warn/i)
  })

  it('preserves error lines', () => {
    const stdout = '  - Downloading vendor/pkg (1.0)\nERROR: Package not found\n'
    const result = composerFilter.apply(stdout, '', 1, ['composer', 'install'])
    expect(result.text).toContain('ERROR: Package not found')
  })
})

// ---------------------------------------------------------------------------
// NuGetFilter
// ---------------------------------------------------------------------------

describe('NuGetFilter', () => {
  it('matches nuget', () => {
    expect(nugetFilter.matches(['nuget', 'restore'])).toBe(true)
  })

  it('matches nuget.exe', () => {
    expect(nugetFilter.matches(['nuget.exe', 'restore'])).toBe(true)
  })

  it('collapses Installing/OK/already-installed/successfully-installed lines', () => {
    const stdout = [
      'Restoring packages for MyProject.csproj',
      'Installing Newtonsoft.Json 13.0.3.',
      'Installing Microsoft.AspNetCore.Http 2.2.2.',
      'OK https://api.nuget.org/v3/index.json',
      'OK https://api.nuget.org/v3/registration5/newtonsoft.json/index.json',
      'Package Newtonsoft.Json 13.0.3 is already installed.',
      'Successfully installed Newtonsoft.Json 13.0.3',
      'All packages installed successfully.',
    ].join('\n')
    const result = nugetFilter.apply(stdout, '', 0, ['nuget', 'restore'])
    expect(result.text).toContain('Restoring packages for MyProject.csproj')
    expect(result.text).not.toContain('Installing Newtonsoft.Json 13.0.3.')
    expect(result.text).not.toContain('OK https://')
    expect(result.text).not.toContain('is already installed')
    expect(result.text).not.toContain('Successfully installed Newtonsoft')
    expect(result.text).toContain('All packages installed successfully.')
  })

  it('emits single Restoring line for 1 project', () => {
    const stdout = 'Restoring packages for MyProject.csproj\nAll packages installed.\n'
    const result = nugetFilter.apply(stdout, '', 0, ['nuget', 'restore'])
    expect(result.text).toContain('Restoring packages for MyProject.csproj')
  })

  it('emits aggregate Restoring for multiple projects', () => {
    const stdout = [
      'Restoring packages for A.csproj',
      'Restoring packages for B.csproj',
      'Restoring packages for C.csproj',
      'All packages restored.',
    ].join('\n')
    const result = nugetFilter.apply(stdout, '', 0, ['nuget', 'restore'])
    expect(result.text).toContain('Restoring packages for 3 projects')
    expect(result.text).not.toContain('Restoring packages for A.csproj')
  })

  it('preserves error lines', () => {
    const stdout = 'Installing Foo 1.0\nERROR: Unexpected error\n'
    const result = nugetFilter.apply(stdout, '', 1, ['nuget', 'restore'])
    expect(result.text).toContain('ERROR: Unexpected error')
  })
})

// ---------------------------------------------------------------------------
// PubFilter (factory-based)
// ---------------------------------------------------------------------------

describe('PubFilter (makePackageManagerFilter factory)', () => {
  it('matches pub get', () => {
    expect(pubFilter.matches(['pub', 'get'])).toBe(true)
  })

  it('matches pub upgrade', () => {
    expect(pubFilter.matches(['pub', 'upgrade'])).toBe(true)
  })

  it('collapses package + download lines, keeps status lines', () => {
    const stdout = [
      'Resolving dependencies...',
      '+ http 1.1.0',
      '> archive 3.3.2 (archive 3.4.0 available)',
      '! outdated_package 1.0.0 (1.0.1 available)',
      'Downloading packages...',
      'Downloading http 1.1.0',
      'Downloading archive 3.4.0',
      'Changed 2 dependencies!',
      'Got dependencies!',
    ].join('\n')
    const result = pubFilter.apply(stdout, '', 0, ['pub', 'get'])
    expect(result.text).toContain('Resolving dependencies')
    expect(result.text).toContain('Changed 2 dependencies!')
    expect(result.text).toContain('Got dependencies!')
    expect(result.text).not.toContain('+ http')
    expect(result.text).not.toContain('> archive')
    expect(result.text).not.toContain('! outdated_package')
    expect(result.text).not.toContain('Downloading http 1.1.0')
    expect(result.text).toContain('collapsed 3 package lines')
    expect(result.text).toContain('collapsed 2 download lines')
  })

  it('preserves error lines', () => {
    const stdout = '+ http 1.1.0\nERROR: Package not found\n'
    const result = pubFilter.apply(stdout, '', 1, ['pub', 'get'])
    expect(result.text).toContain('ERROR: Package not found')
  })
})

// ---------------------------------------------------------------------------
// ConanFilter (errorPassthrough = true)
// ---------------------------------------------------------------------------

describe('ConanFilter', () => {
  it('matches conan install', () => {
    expect(conanFilter.matches(['conan', 'install', '.'])).toBe(true)
  })

  it('matches conan2', () => {
    expect(conanFilter.matches(['conan2', 'install', '.'])).toBe(true)
  })

  it('errorPassthrough=true: returns stderr on non-zero exit', () => {
    const stderr = 'ERROR: package not found in remotes'
    const result = conanFilter.apply('', stderr, 1, ['conan', 'install', '.'])
    expect(result.text).toContain('ERROR: package not found')
  })

  it('collapses per-package lifecycle lines, keeps Requirements/done lines', () => {
    const stdout = [
      'Requirements',
      '    zlib/1.2.11#rev from conan-center',
      'Packages',
      'zlib/1.2.11@_/_: Package \'abc123\' already exists',
      'zlib/1.2.11@_/_: Calling build()',
      'zlib/1.2.11@_/_: Calling package()',
      'zlib/1.2.11@_/_: Decompressing ',
      'Downloading conan_zlib.tgz',
      '1024/2048 bytes downloaded',
      'Install finished',
    ].join('\n')
    const result = conanFilter.apply(stdout, '', 0, ['conan', 'install', '.'])
    expect(result.text).toContain('Requirements')
    expect(result.text).toContain('Packages')
    expect(result.text).toContain('Install finished')
    expect(result.text).not.toContain('Calling build()')
    expect(result.text).not.toContain('Calling package()')
    expect(result.text).toMatch(/collapsed/i)
  })
})

// ---------------------------------------------------------------------------
// VcpkgFilter (errorPassthrough = true)
// ---------------------------------------------------------------------------

describe('VcpkgFilter', () => {
  it('matches vcpkg', () => {
    expect(vcpkgFilter.matches(['vcpkg', 'install', 'zlib'])).toBe(true)
  })

  it('errorPassthrough=true: returns stderr on non-zero exit', () => {
    const stderr = 'error: package zlib not found'
    const result = vcpkgFilter.apply('', stderr, 1, ['vcpkg', 'install', 'zlib'])
    expect(result.text).toContain('error: package zlib not found')
  })

  it('collapses Building/Installing port lines, keeps plan and done lines', () => {
    const stdout = [
      'The following packages will be installed:',
      '    zlib:x64-windows',
      '    libpng:x64-windows',
      'Building zlib:x64-windows...',
      '  -- Extracting source',
      '  -- Applying patch fix.patch',
      '  -- Using cached archive',
      '  -- Downloading https://example.com/zlib.tar.gz',
      'Installing zlib:x64-windows...',
      'Building libpng:x64-windows...',
      'Installing libpng:x64-windows...',
      'Elapsed time for package zlib:x64-windows: 5.5 s',
      'Total install time: 12.3 s',
      'CMake projects should use: find_package(ZLIB)',
    ].join('\n')
    const result = vcpkgFilter.apply(stdout, '', 0, ['vcpkg', 'install', 'zlib'])
    expect(result.text).toContain('The following packages will be installed')
    expect(result.text).toContain('Total install time')
    expect(result.text).not.toContain('Building zlib:x64-windows...')
    expect(result.text).not.toContain('Installing zlib:x64-windows...')
    expect(result.text).not.toContain('Extracting source')
    expect(result.text).not.toContain('Elapsed time for package')
    expect(result.text).toMatch(/collapsed/i)
  })
})

// ---------------------------------------------------------------------------
// NodePackageFilter (general npm/pnpm/yarn)
// ---------------------------------------------------------------------------

describe('NodePackageFilter', () => {
  it('matches npm (non-install subcommands)', () => {
    expect(npmFilter.matches(['npm', 'audit'])).toBe(true)
  })

  it('matches yarn', () => {
    expect(npmFilter.matches(['yarn', 'info', 'lodash'])).toBe(true)
  })

  it('drops spinner/progress and deprecated noise, emits summary', () => {
    const stdout = [
      '⠋ reify:node_modules/express',
      '⠙ reify:node_modules/lodash',
      'npm WARN deprecated lodash@3.10.1: pkg is deprecated',
      'npm WARN deprecated mkdirp@0.5.5: another deprecated pkg',
      'added 42 packages in 1s',
    ].join('\n')
    const result = npmFilter.apply(stdout, '', 0, ['npm', 'update'])
    expect(result.text).not.toContain('⠋ reify')
    expect(result.text).not.toContain('npm WARN deprecated lodash')
    // npm WARN deprecated lines are silently dropped by the progress RE — no collapsed note
    expect(result.text).toContain('added 42 packages')
  })
})

// ---------------------------------------------------------------------------
// DepListFilter
// ---------------------------------------------------------------------------

describe('DepListFilter', () => {
  it('matches pip list', () => {
    expect(depListFilter.matches(['pip', 'list'])).toBe(true)
  })

  it('matches pip freeze', () => {
    expect(depListFilter.matches(['pip', 'freeze'])).toBe(true)
  })

  it('matches uv pip freeze', () => {
    expect(depListFilter.matches(['uv', 'pip', 'freeze'])).toBe(true)
  })

  it('matches npm list', () => {
    expect(depListFilter.matches(['npm', 'list'])).toBe(true)
  })

  it('matches cargo tree', () => {
    expect(depListFilter.matches(['cargo', 'tree'])).toBe(true)
  })

  it('passes through ≤30 packages unchanged', () => {
    const out = Array.from({ length: 25 }, (_, i) => `pkg${i}==1.0`).join('\n')
    const result = depListFilter.apply(out, '', 0, ['pip', 'list'])
    expect(result.text).toContain('pkg0==1.0')
    expect(result.text).toContain('pkg24==1.0')
    expect(result.text).not.toMatch(/more packages/i)
  })

  it('truncates at 30, emits count + hint for pip freeze', () => {
    const out = Array.from({ length: 50 }, (_, i) => `pkg${i}==1.0`).join('\n')
    const result = depListFilter.apply(out, '', 0, ['pip', 'freeze'])
    expect(result.text).toContain('pkg0==1.0')
    expect(result.text).toContain('pkg29==1.0')
    expect(result.text).not.toContain('pkg30==1.0')
    expect(result.text).toContain('20 more packages')
    expect(result.text).toContain('pip freeze')
  })

  it('truncates at 30, emits count + hint for uv pip freeze', () => {
    const out = Array.from({ length: 50 }, (_, i) => `pkg${i}==1.0`).join('\n')
    const result = depListFilter.apply(out, '', 0, ['uv', 'pip', 'freeze'])
    expect(result.text).toContain('20 more packages')
    expect(result.text).toContain('uv pip freeze')
  })
})

// ---------------------------------------------------------------------------
// Dispatch integration
// ---------------------------------------------------------------------------

describe('Dispatch: package-manager filters in TOOL_FILTERS', () => {
  it('pnpm install dispatches to npm_install filter', () => {
    const f = selectFilter(['pnpm', 'install'])
    expect(f?.name).toBe('npm_install')
  })

  it('pnpm run dispatches to pnpm filter (not stripped as prefix)', () => {
    const f = selectFilter(['pnpm', 'run', 'dev'])
    expect(f?.name).toBe('pnpm')
  })

  it('yarn install dispatches to npm_install filter', () => {
    const f = selectFilter(['yarn', 'install'])
    expect(f?.name).toBe('npm_install')
  })

  it('yarn (bare) dispatches to npm_install filter (bare yarn = yarn install)', () => {
    const f = selectFilter(['yarn'])
    expect(f?.name).toBe('npm_install')
  })

  it('conda install dispatches to conda filter', () => {
    const f = selectFilter(['conda', 'install', 'numpy'])
    expect(f?.name).toBe('conda')
  })

  it('mamba install dispatches to conda filter', () => {
    const f = selectFilter(['mamba', 'install', 'scipy'])
    expect(f?.name).toBe('conda')
  })

  it('bundle install dispatches to bundler filter', () => {
    const f = selectFilter(['bundle', 'install'])
    expect(f?.name).toBe('bundler')
  })

  it('pub get dispatches to pub filter', () => {
    const f = selectFilter(['pub', 'get'])
    expect(f?.name).toBe('pub')
  })

  it('vcpkg install dispatches to vcpkg filter', () => {
    const f = selectFilter(['vcpkg', 'install', 'zlib'])
    expect(f?.name).toBe('vcpkg')
  })

  it('detectFromCommand resolves npm install to npm_install filter', () => {
    const result = detectFromCommand('npm install')
    expect(result?.filter.name).toBe('npm_install')
  })

  it('detectFromCommand resolves pip freeze to pip filter (pip precedes dep-list in dispatch order)', () => {
    const result = detectFromCommand('pip freeze')
    expect(result?.filter.name).toBe('pip')
  })

  it('detectFromCommand resolves cargo tree to dep-list filter', () => {
    const result = detectFromCommand('cargo tree')
    expect(result?.filter.name).toBe('dep-list')
  })

  // Regression: TWO_TOKEN_PREFIXES used to list `tool` as a generic two-token
  // trigger for `uv`, so `uv tool install/run <bin>` was stripped the same way
  // as `uv run <bin>` (consume 2 -> ['install'|'run', bin]), landing on a
  // subcommand token that matches no filter. `uv tool install` must stay
  // unstripped (UvFilter's own `tool` branch claims it -- it's uv's own
  // package-management output, not the tool's own output), while
  // `uv tool run` needs a dedicated 3-token strip since it really does
  // execute `<bin>` and stream its output.
  it('uv tool install <bin> dispatches to the uv filter (real argv-stripping path)', () => {
    const f = selectFilter(['uv', 'tool', 'install', 'ruff'])
    expect(f?.name).toBe('uv')
  })

  it('uv tool run <bin> dispatches to the binary\'s own filter, not uv (real argv-stripping path)', () => {
    const f = selectFilter(['uv', 'tool', 'run', 'ruff', 'check', '.'])
    expect(f?.name).toBe('ruff')
  })

  // Regression: NodePackageFilter/PnpmFilter/YarnFilter each matched their
  // binary unconditionally (no subcommand gate), so `npm list`/`pnpm list`/
  // `yarn list` never reached DepListFilter's 30-line cap -- they were
  // intercepted first. Direct `.matches()` calls on the isolated DepListFilter
  // instance (see the `DepListFilter` describe block above) don't exercise
  // this: they skip the earlier filters in PACKAGE_MANAGER_FILTERS entirely.
  // These go through the real selectFilter/stripPrefixes dispatch path.
  it('npm list dispatches to dep-list filter (real dispatch path, not npm/npm_install)', () => {
    const f = selectFilter(['npm', 'list'])
    expect(f?.name).toBe('dep-list')
  })

  it('pnpm list dispatches to dep-list filter (real dispatch path, not pnpm)', () => {
    const f = selectFilter(['pnpm', 'list'])
    expect(f?.name).toBe('dep-list')
  })

  it('yarn list dispatches to dep-list filter (real dispatch path, not yarn)', () => {
    const f = selectFilter(['yarn', 'list'])
    expect(f?.name).toBe('dep-list')
  })

  it('pnpm install still dispatches to npm_install filter (list-only carve-out doesn\'t break install)', () => {
    const f = selectFilter(['pnpm', 'install'])
    expect(f?.name).toBe('npm_install')
  })
})

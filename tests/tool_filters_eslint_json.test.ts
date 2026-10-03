// `eslint -f json` prints one report line. The generic wide-line clip (base.ts step 2b) cut any such line over 4000 chars to its two ends before the eslint filter ran, so only the first file survived and every count was gone. The eslint filter now rewrites the JSON report into stylish rows before the clip.
import { describe, expect, it } from 'vitest'

import { LINTER_FILTERS, TOOL_FILTERS } from '../src/tool_filters/index.js'

const eslintFilter = [...TOOL_FILTERS, ...LINTER_FILTERS].find((f) => f.name === 'eslint')!

// CAPTURE: real output of `eslint -f json src` (eslint from this repo's node_modules, exit 1) over a scratch project with src/a.js (a parse error), src/b.js (one error, one warning) and src/c.js (clean). Only the path root differs from the capture's location on disk; the bytes are otherwise as printed.
const CAPTURE = String.raw`[{"filePath":"C:\\tgwt\\r15c-scratch\\proj\\src\\a.js","messages":[{"ruleId":null,"fatal":true,"severity":2,"message":"Parsing error: The keyword 'let' is reserved","line":3,"column":1}],"suppressedMessages":[],"errorCount":1,"fatalErrorCount":1,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"source":"var a = 1\nconsole.log(a == 2)\nlet = ;\n","usedDeprecatedRules":[]},{"filePath":"C:\\tgwt\\r15c-scratch\\proj\\src\\b.js","messages":[{"ruleId":"no-unused-vars","severity":2,"message":"'unused' is assigned a value but never used.","line":1,"column":7,"messageId":"unusedVar","endLine":1,"endColumn":13,"suggestions":[{"messageId":"removeVar","data":{"varName":"unused"},"fix":{"range":[0,16],"text":""},"desc":"Remove unused variable 'unused'."}]},{"ruleId":"no-console","severity":1,"message":"Unexpected console statement.","line":2,"column":1,"messageId":"unexpected","endLine":2,"endColumn":12,"suggestions":[{"fix":{"range":[17,33],"text":""},"messageId":"removeConsole","data":{"propertyName":"log"},"desc":"Remove the console.log()."}]}],"suppressedMessages":[],"errorCount":1,"fatalErrorCount":0,"warningCount":1,"fixableErrorCount":0,"fixableWarningCount":0,"source":"const unused = 1\nconsole.log(\"x\")\n","usedDeprecatedRules":[]},{"filePath":"C:\\tgwt\\r15c-scratch\\proj\\src\\c.js","messages":[],"suppressedMessages":[],"errorCount":0,"fatalErrorCount":0,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"usedDeprecatedRules":[]}]`

describe('ESLintFilter on -f json output', () => {
  it('keeps every file, each row and the totals from a captured report', () => {
    const text = eslintFilter.apply(CAPTURE, '', 1, ['eslint', '-f', 'json', 'src']).text
    expect(text).toContain('a.js')
    expect(text).toContain('3:1')
    expect(text).toContain("Parsing error: The keyword 'let' is reserved")
    expect(text).toContain('b.js')
    expect(text).toContain('1:7')
    expect(text).toMatch(/error\s+'unused' is assigned a value but never used\.\s+no-unused-vars/)
    expect(text).toMatch(/warning\s+Unexpected console statement\.\s+no-console/)
    expect(text).toContain('3 problems (2 errors, 1 warning)')
    expect(text).not.toContain('c.js')
    expect(text).not.toContain('"filePath"')
  })

  it('survives a report wider than the clip, where the last file and the totals used to vanish', () => {
    // FORMAT-DERIVED: the entry shape is https://eslint.org/docs/latest/use/formatters/#json (filePath, messages[ruleId, severity, message, line, column]); the 40 files and their counts are generated here, and the totals below are counted from that loop.
    const files = Array.from({ length: 40 }, (_, i) => ({
      filePath: `/proj/src/file${i}.js`,
      messages: [{ ruleId: 'no-unused-vars', severity: 2, message: `'v${i}' is defined but never used.`, line: i + 1, column: 7 }],
      source: 'x'.repeat(200),
    }))
    const wide = JSON.stringify(files)
    expect(wide.length).toBeGreaterThan(4000)
    expect(wide.includes('\n')).toBe(false)
    const text = eslintFilter.apply(wide, '', 1, ['eslint', '-f', 'json', 'src']).text
    expect(text).toContain('40 problems (40 errors, 0 warnings)')
    expect(text).toContain('file39.js')
    expect(text).toContain('40:7')
  })

  it('reports a clean json run as no problems', () => {
    const text = eslintFilter.apply('[{"filePath":"/proj/a.js","messages":[]}]', '', 0, ['eslint', '-f', 'json', '.']).text
    expect(text).toMatch(/no problems|no errors/i)
  })

  it('keeps the blank line between file stanzas after the grouped warnings, not between errors and warnings', () => {
    // CAPTURE: real stylish output of `eslint --no-config-lookup --rule no-unused-vars:2 --rule no-var:1 bad.js bad2.js` (eslint from this repo's node_modules, exit 1) over a scratch project; only the path root differs from the capture.
    const stylish = String.raw`
C:\tgwt\dog15\proj\bad.js
  1:1   warning  Unexpected var, use let or const instead  no-var
  1:5   error    'a' is assigned a value but never used    no-unused-vars
  2:1   warning  Unexpected var, use let or const instead  no-var
  2:5   error    'b' is assigned a value but never used    no-unused-vars
  3:10  error    'f' is defined but never used             no-unused-vars
  3:12  error    'x' is defined but never used             no-unused-vars

C:\tgwt\dog15\proj\bad2.js
  1:1  warning  Unexpected var, use let or const instead     no-var
  1:5  error    'unused' is assigned a value but never used  no-unused-vars

✖ 8 problems (5 errors, 3 warnings)
  0 errors and 3 warnings potentially fixable with the ` + '`--fix`' + String.raw` option.
`
    const lines = eslintFilter.compress(stylish, '', 1, ['eslint', 'bad.js', 'bad2.js']).split('\n')
    const first = lines.findIndex((l) => l.endsWith('bad.js'))
    const second = lines.findIndex((l) => l.endsWith('bad2.js'))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
    const firstStanza = lines.slice(first + 1, second)
    expect(firstStanza.filter((l) => l.trim() !== '')).toHaveLength(6)
    expect(firstStanza.at(-1)).toBe('')
    expect(firstStanza.slice(0, -1).every((l) => l.trim() !== '')).toBe(true)
  })

  it('leaves non-report json untouched', () => {
    const text = eslintFilter.apply('[1,2,3]', '', 1, ['eslint', '-f', 'json', '.']).text
    expect(text).toContain('[1,2,3]')
  })
})

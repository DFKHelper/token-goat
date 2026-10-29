import { describe, expect, it } from 'vitest'
import { extractPhp } from '../src/languages/php.js'
import { detectLanguage } from '../src/parser_types.js'

describe('legacy PHP file detection', () => {
  it('recognizes include and class filenames as PHP', () => {
    for (const filePath of ['rules.inc', 'rules.inc.php', 'Legacy.class.php']) {
      expect(detectLanguage(filePath)).toBe('php')
    }
  })

  it('spans a nested property array for a focused read without crossing the next method', () => {
    const source = `<?php
class LegacySettings {
    private $rules = array(
        'first' => array('literal' => ') ]'),
        'last' => ['value' => 7], // ] ) are comment text
    );
    public function afterRules() {}
}
`
    const { symbols } = extractPhp(source, 'legacy.inc.php')
    const rules = symbols.find((symbol) => symbol.name === 'rules')

    expect(rules?.lineStart).toBe(3)
    expect(rules?.lineEnd).toBe(6)
    expect(rules?.body).toContain("'last'")
    expect(symbols.find((symbol) => symbol.name === 'afterRules')?.lineStart).toBe(7)
  })

  it('indexes and spans a top-level array in a procedural include', () => {
    const source = `<?php
$legacyRoutes = [
    'home' => '/index.php',
    'last' => '/done.php',
];
function routeFromInclude() {}
`
    const { symbols } = extractPhp(source, 'routes.inc')
    const routes = symbols.find((symbol) => symbol.name === 'legacyRoutes')

    expect(routes?.kind).toBe('var')
    expect(routes?.lineStart).toBe(2)
    expect(routes?.lineEnd).toBe(5)
    expect(routes?.body).toContain("'last'")
    expect(symbols.find((symbol) => symbol.name === 'routeFromInclude')?.lineStart).toBe(6)
  })

  it('indexes a literal eval declaration without executing it or inferring dynamic names', () => {
    const source = `<?php
eval('function fromLiteralEval() { return 1; }');
eval('function ' . $suffix . '() {}');
`
    const { symbols } = extractPhp(source, 'legacy.inc.php')

    expect(symbols.find((symbol) => symbol.name === 'fromLiteralEval')?.kind).toBe('function')
    expect(symbols.find((symbol) => symbol.name === 'fromLiteralEval')?.lineStart).toBe(2)
    expect(symbols.some((symbol) => symbol.name === 'suffix')).toBe(false)
  })

  it('indexes an assigned create_function callback without parsing its body string', () => {
    const source = `<?php
$legacyMapper = create_function(
    '$value',
    'return "function notADeclaration() {}";'
);
`
    const { symbols } = extractPhp(source, 'legacy.inc.php')
    const mapper = symbols.find((symbol) => symbol.name === 'legacyMapper')

    expect(mapper?.kind).toBe('function')
    expect(mapper?.lineEnd).toBe(5)
    expect(mapper?.body).toContain('notADeclaration')
    expect(symbols.some((symbol) => symbol.name === 'notADeclaration')).toBe(false)
  })
})

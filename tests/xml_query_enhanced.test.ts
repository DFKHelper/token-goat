import { describe, expect, it } from 'vitest'
import {
  parseXmlTree,
  queryXml,
  serializeXmlNode,
  tryDecodeEmbeddedXml,
} from '../src/xml_query.js'
import { runXmlOutline, runXmlQuery, runRead } from '../src/read_commands.js'
import { captureStdout } from './helpers/capture-stdout.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const SSIS_SAMPLE = `<?xml version="1.0"?>
<DTS:Executable xmlns:DTS="www.microsoft.com/SqlServer/Dts"
  DTS:ExecutableType="Microsoft.Package"
  DTS:ObjectName="CustomerETL">
  <DTS:Executables>
    <DTS:Executable DTS:ExecutableType="Microsoft.ExecuteSQLTask" DTS:ObjectName="Truncate Staging">
      <DTS:Property DTS:Name="SqlStatementSource">TRUNCATE TABLE Stage_Customers;</DTS:Property>
    </DTS:Executable>
    <DTS:Executable DTS:ExecutableType="Microsoft.Pipeline" DTS:ObjectName="Load Dimension">
      <DTS:Property DTS:Name="Description">Data flow task for dimensions</DTS:Property>
    </DTS:Executable>
  </DTS:Executables>
</DTS:Executable>`

const AUTOMATE_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<Task Name="MigrateWorkflow" Version="2026.1">
  <Step StepType="AMAML" StepNumber="1">
    <AML>&lt;AMLOOP Type="LIST" ITEMS="a,b,c"&gt;&lt;AMMESSAGE&gt;Running Item&lt;/AMMESSAGE&gt;&lt;/AMLOOP&gt;</AML>
  </Step>
</Task>`

describe('Enhanced XPath & XML Query', () => {
  it('queries SSIS package elements with namespaces and attribute predicates', () => {
    const res = queryXml(SSIS_SAMPLE, '//DTS:Executable[@DTS:ExecutableType="Microsoft.ExecuteSQLTask"]')
    expect(res.items.length).toBe(1)
    expect(res.items[0]?.attributes['DTS:ObjectName']).toBe('Truncate Staging')
  })

  it('matches element names ignoring namespace prefix when prefix is omitted in query', () => {
    const res = queryXml(SSIS_SAMPLE, '//Executable[@ObjectName="Truncate Staging"]')
    expect(res.items.length).toBe(1)
    expect(res.items[0]?.tag).toBe('DTS:Executable')
  })

  it('evaluates contains() predicate on attributes', () => {
    const res = queryXml(SSIS_SAMPLE, '//DTS:Executable[contains(@DTS:ObjectName, "Dimension")]')
    expect(res.items.length).toBe(1)
    expect(res.items[0]?.attributes['DTS:ObjectName']).toBe('Load Dimension')
  })

  it('evaluates local-name() predicate in XPath', () => {
    const res = queryXml(SSIS_SAMPLE, '//*[local-name()="Property"][@DTS:Name="SqlStatementSource"]')
    expect(res.items.length).toBe(1)
    expect(res.items[0]?.text).toBe('TRUNCATE TABLE Stage_Customers;')
  })

  it('extracts attribute values with namespaces and collects source node metadata', () => {
    const res = queryXml(SSIS_SAMPLE, '//DTS:Executable/@DTS:ObjectName')
    expect(res.attributeValues).toEqual(['CustomerETL', 'Truncate Staging', 'Load Dimension'])
    expect(res.attributeNodes?.length).toBe(3)
    expect(res.attributeNodes?.[1]?.node.line).toBeGreaterThan(0)
  })

  it('tracks accurate line and lineEnd spans on parsed XML nodes', () => {
    const { root } = parseXmlTree(SSIS_SAMPLE)
    expect(root).not.toBeNull()
    expect(root!.line).toBe(2)
    expect(root!.lineEnd).toBe(13)

    const truncateNode = root!.children[0]?.children[0]
    expect(truncateNode?.tag).toBe('DTS:Executable')
    expect(truncateNode?.line).toBe(6)
    expect(truncateNode?.lineEnd).toBe(8)
  })
})

describe('Decoded Embedded XML & AML', () => {
  it('decodes entity-encoded AML inside text content', () => {
    const rawAml = '&lt;AMLOOP Type="LIST" ITEMS="a,b,c"&gt;&lt;AMMESSAGE&gt;Running Item&lt;/AMMESSAGE&gt;&lt;/AMLOOP&gt;'
    const decoded = tryDecodeEmbeddedXml(rawAml)
    expect(decoded.decoded).toBe(true)
    expect(decoded.text).toContain('<AMLOOP Type="LIST" ITEMS="a,b,c">')
    expect(decoded.text).toContain('<AMMESSAGE>Running Item</AMMESSAGE>')
  })

  it('bounds decoded embedded XML output when lines exceed maxLines', () => {
    const manyLines = Array.from({ length: 40 }, (_, i) => `<Step id="${i}">Action ${i}</Step>`).join('')
    const raw = `&lt;Workflow&gt;${manyLines}&lt;/Workflow&gt;`
    const decoded = tryDecodeEmbeddedXml(raw, { maxLines: 10 })
    expect(decoded.decoded).toBe(true)
    expect(decoded.text).toContain('lines of decoded embedded XML elided; bounded')
  })

  it('serializes node with decoded embedded XML banner', () => {
    const { root } = parseXmlTree(AUTOMATE_SAMPLE)
    const amlNode = root!.children[0]?.children[0]
    expect(amlNode?.tag).toBe('AML')
    const serialized = serializeXmlNode(amlNode!, 0, { decodeEmbedded: true })
    expect(serialized).toContain('[Decoded Embedded XML]')
    expect(serialized).toContain('<AMLOOP')
  })
})

describe('runXmlQuery CLI integration with --with-lines and --decode-embedded-xml', () => {
  it('emits source line annotations in text mode when --with-lines is passed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xml-enh-'))
    const xmlFile = path.join(tmpDir, 'package.dtsx')
    fs.writeFileSync(xmlFile, SSIS_SAMPLE, 'utf8')

    try {
      const out = captureStdout(() => {
        runXmlQuery({
          file: xmlFile,
          xpath: '//DTS:Executable[@DTS:ObjectName="Truncate Staging"]',
          withLines: true,
        })
      })
      expect(out).toContain('# Lines: L6-L8')
      expect(out).toContain('<DTS:Executable')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('emits lineStart and lineEnd in JSON mode when --with-lines is passed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xml-enh-'))
    const xmlFile = path.join(tmpDir, 'package.dtsx')
    fs.writeFileSync(xmlFile, SSIS_SAMPLE, 'utf8')

    try {
      const out = captureStdout(() => {
        runXmlQuery({
          file: xmlFile,
          xpath: '//DTS:Executable[@DTS:ObjectName="Truncate Staging"]',
          withLines: true,
          json: true,
        })
      })
      const parsed = JSON.parse(out)
      const target = parsed.items ? parsed.items[0] : parsed
      expect(target.lineStart).toBe(6)
      expect(target.lineEnd).toBe(8)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('decodes embedded AML in runXmlQuery with --decode-embedded-xml', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xml-enh-'))
    const xmlFile = path.join(tmpDir, 'spec.ampkg')
    fs.writeFileSync(xmlFile, AUTOMATE_SAMPLE, 'utf8')

    try {
      const out = captureStdout(() => {
        runXmlQuery({
          file: xmlFile,
          path: '//AML',
          decodeEmbeddedXml: true,
        })
      })
      expect(out).toContain('[Decoded Embedded XML]')
      expect(out).toContain('<AMLOOP')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('runXmlOutline depth support', () => {
  it('limits depth when maxDepth option is provided', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xml-enh-'))
    const xmlFile = path.join(tmpDir, 'test.xml')
    fs.writeFileSync(xmlFile, SSIS_SAMPLE, 'utf8')

    try {
      const out = captureStdout(() => {
        runXmlOutline({
          file: xmlFile,
          maxDepth: 1,
        })
      })
      expect(out).toContain('max depth 1')
      expect(out).not.toContain('Truncate Staging')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Unqualified YAML read guidance', () => {
  it('points users to yaml-outline and yaml-query on missing symbol in YAML file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-yaml-guidance-'))
    const yamlFile = path.join(tmpDir, 'config.yaml')
    fs.writeFileSync(yamlFile, 'database:\n  host: localhost\n  port: 5432\n', 'utf8')

    try {
      const result = runRead({
        spec: `${yamlFile}::nonexistentKey`,
        forceRefresh: false,
      })
      expect(result.code).toBe(1)
      expect(result.text).toContain('token-goat yaml-outline')
      expect(result.text).toContain('token-goat yaml-query')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

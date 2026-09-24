import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHookEvent } from './helpers/hook-event.js'
import { expectHookType } from './helpers/hook-output.js'
import {
  classifyFileExtensions,
  surgicalHintFor,
  surgicalHintForConfigDoc,
  extractTerminalXmlParsing,
} from '../src/bash_extractors.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { preReadHandler } from '../src/hooks_read.js'
import { dispatchFileTypeHandler } from '../src/hints/file_type_handler.js'
import { clearModuleCaches } from '../src/reset.js'
import { HINT_PLACEHOLDERS } from '../src/hint_target.js'

describe('XML, DTSX, AMPKG, XAML runtime recognition & terminal XML interception', () => {
  let tempDir: string

  beforeEach(() => {
    clearModuleCaches()
    tempDir = mkdtempSync(join(tmpdir(), 'tg-xml-nudge-test-'))
  })

  afterEach(() => {
    clearModuleCaches()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  describe('classifyFileExtensions', () => {
    it('recognizes .xml, .dtsx, .ampkg, .xaml as isXml', () => {
      expect(classifyFileExtensions('Package.dtsx')).toEqual({
        isDoc: false,
        isEnv: false,
        isConfig: false,
        isSql: false,
        isXml: true,
      })
      expect(classifyFileExtensions('Workflow.ampkg')).toEqual({
        isDoc: false,
        isEnv: false,
        isConfig: false,
        isSql: false,
        isXml: true,
      })
      expect(classifyFileExtensions('App.xaml')).toEqual({
        isDoc: false,
        isEnv: false,
        isConfig: false,
        isSql: false,
        isXml: true,
      })
      expect(classifyFileExtensions('config.xml')).toEqual({
        isDoc: false,
        isEnv: false,
        isConfig: false,
        isSql: false,
        isXml: true,
      })
    })
  })

  describe('surgical hints for XML formats', () => {
    it('produces xml-outline and xml-query guidance when isXml is true', () => {
      // The XML branch names no heading, key or symbol, so an unresolved target stands in.
      const noTarget = { name: HINT_PLACEHOLDERS.section, real: false, slice: 'section' } as const
      const hint = surgicalHintFor('Package.dtsx', false, false, false, true, noTarget)
      expect(hint).toContain('token-goat xml-outline "Package.dtsx"')
      expect(hint).toContain('token-goat xml-query "Package.dtsx" "<selector>"')

      const cfgHint = surgicalHintForConfigDoc('Workflow.ampkg', false, false, false, true, noTarget)
      expect(cfgHint).toContain('token-goat xml-outline "Workflow.ampkg"')
      expect(cfgHint).toContain('token-goat xml-query "Workflow.ampkg" "<selector>"')
    })
  })

  describe('extractTerminalXmlParsing', () => {
    it('detects Select-Xml commands', () => {
      const res = extractTerminalXmlParsing('Select-Xml -Path "workflow.ampkg" -XPath "//node"')
      expect(res).not.toBeNull()
      expect(res?.toolOrScript).toBe('Select-Xml')
      expect(res?.filePath).toBe('workflow.ampkg')
    })

    it('detects PowerShell [xml] casts', () => {
      const res = extractTerminalXmlParsing('[xml]$doc = Get-Content "package.dtsx"')
      expect(res).not.toBeNull()
      expect(res?.toolOrScript).toBe('[xml]')
      expect(res?.filePath).toBe('package.dtsx')
    })

    it('detects scratch PowerShell inspect scripts', () => {
      const res = extractTerminalXmlParsing('powershell -File .\\inspect_workflows.ps1 "workflows.ampkg"')
      expect(res).not.toBeNull()
      expect(res?.toolOrScript).toContain('inspect_workflows.ps1')
      expect(res?.filePath).toBe('workflows.ampkg')
    })

    it('detects Python xml.etree one-liners', () => {
      const res = extractTerminalXmlParsing('python -c "import xml.etree.ElementTree as ET; tree = ET.parse(\'data.xml\')"')
      expect(res).not.toBeNull()
      expect(res?.toolOrScript).toContain('xml.etree')
      expect(res?.filePath).toBe('data.xml')
    })

    it('detects shell XML CLI utilities (xmllint)', () => {
      const res = extractTerminalXmlParsing('xmllint --xpath "//task" package.xml')
      expect(res).not.toBeNull()
      expect(res?.toolOrScript).toBe('xmllint')
      expect(res?.filePath).toBe('package.xml')
    })

    it('returns null for unrelated commands', () => {
      expect(extractTerminalXmlParsing('git status')).toBeNull()
      expect(extractTerminalXmlParsing('npm test')).toBeNull()
      expect(extractTerminalXmlParsing('python script.py')).toBeNull()
    })
  })

  describe('preBashHandler terminal XML parsing interception', () => {
    it('emits advisory context note redirecting to xml-query / xml-outline', () => {
      const event = makeHookEvent({
        toolName: 'Bash',
        toolInput: { command: 'Select-Xml -Path "package.dtsx" -XPath "//DTS:Executable"' },
      })
      const out = preBashHandler(event)
      expectHookType(out, 'context')
      expect(out.context).toContain('token-goat available for this file type')
      expect(out.context).toContain('token-goat xml-query "package.dtsx" "<xpath>"')
      expect(out.context).toContain('token-goat xml-outline "package.dtsx"')
      expect(out.context).toContain('(Select-Xml)')
    })

    it('warns on scratch PowerShell inspect scripts', () => {
      const event = makeHookEvent({
        toolName: 'Bash',
        toolInput: { command: 'pwsh .\\inspect_workflows.ps1 "exported_workflows.ampkg"' },
      })
      const out = preBashHandler(event)
      expectHookType(out, 'context')
      expect(out.context).toContain('token-goat available for this file type')
      expect(out.context).toContain('token-goat xml-query "exported_workflows.ampkg" "<xpath>"')
    })
  })

  describe('file_type_handler package thresholds', () => {
    it('blocks .dtsx files above 20KB and labels as SSIS package XML', () => {
      const filePath = join(tempDir, 'BigPackage.dtsx')
      const content = '<DTS:Executable>' + 'x'.repeat(25 * 1024) + '</DTS:Executable>'
      writeFileSync(filePath, content, 'utf8')

      const res = dispatchFileTypeHandler(filePath, content, content.length)
      expect(res).not.toBeNull()
      expect(res?.shouldBlock).toBe(true)
      expect(res?.message).toContain('SSIS package XML')
      expect(res?.message).toContain('token-goat xml-outline')
      expect(res?.message).toContain('token-goat xml-query')
      expect(res?.message).toContain('Query specific elements')
    })

    it('blocks .ampkg files above 20KB and labels as workflow package XML', () => {
      const filePath = join(tempDir, 'BigWorkflow.ampkg')
      const content = '<WorkflowPackage>' + 'y'.repeat(25 * 1024) + '</WorkflowPackage>'
      writeFileSync(filePath, content, 'utf8')

      const res = dispatchFileTypeHandler(filePath, content, content.length)
      expect(res).not.toBeNull()
      expect(res?.shouldBlock).toBe(true)
      expect(res?.message).toContain('workflow package XML')
      expect(res?.message).toContain('token-goat xml-outline')
      expect(res?.message).toContain('token-goat xml-query')
    })
  })

  describe('preReadHandler runtime nudges', () => {
    it('emits pre-read runtime nudge on moderate-sized XML/DTSX reads under threshold', () => {
      const filePath = join(tempDir, 'Moderate.dtsx')
      // Create a 6KB file (>= 5KB, < 20KB threshold)
      const content = '<DTS:Executable>\n' + '  <Task name="test" />\n'.repeat(200) + '</DTS:Executable>'
      writeFileSync(filePath, content, 'utf8')

      const event = makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: filePath },
      })
      const out = preReadHandler(event)
      expectHookType(out, 'context')
      expect(out.context).toContain('token-goat available for this file type, consider xml-query/xml-outline first')
      expect(out.context).toContain('token-goat xml-outline')
      expect(out.context).toContain('token-goat xml-query')
    })

    it('emits pre-read runtime nudge on moderate-sized markdown reads', () => {
      const filePath = join(tempDir, 'technical-solution.md')
      // Create a 6KB markdown file (>= 50 lines)
      const lines = ['# Technical Solution', '## Overview', 'Some text']
      for (let i = 0; i < 60; i++) {
        lines.push(`### Step ${i}\nDetails about step ${i}`)
      }
      writeFileSync(filePath, lines.join('\n'), 'utf8')

      const event = makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: filePath },
      })
      const out = preReadHandler(event)
      expectHookType(out, 'context')
      expect(out.context).toContain('token-goat available for this file type, consider section first')
      expect(out.context).toContain('token-goat section')
    })

    it('detects and denies sequential line-range paging on .md and .dtsx files', () => {
      const mdPath = join(tempDir, 'paged-doc.md')
      writeFileSync(mdPath, '# Doc\n' + 'line\n'.repeat(100), 'utf8')

      // Perform 3 sequential slices through preReadHandler
      preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: mdPath, offset: 1, limit: 20 },
      }))
      preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: mdPath, offset: 21, limit: 20 },
      }))
      preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: mdPath, offset: 41, limit: 20 },
      }))

      // 4th sequential range request
      const event = makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: mdPath, offset: 61, limit: 20 },
      })
      const out = preReadHandler(event)
      expectHookType(out, 'deny')
      expect(out.message).toContain('Sequential line-range paging detected on')
      expect(out.message).toContain('Inspect structure directly without manual chunk paging')
      expect(out.message).toContain('token-goat section')
    })

    it('detects and denies sequential line-range paging on .dtsx files', () => {
      const dtsxPath = join(tempDir, 'paged-package.dtsx')
      writeFileSync(dtsxPath, '<DTS:Executable>\n' + '  <DTS:Task />\n'.repeat(100) + '</DTS:Executable>', 'utf8')

      // Perform 3 sequential slices through preReadHandler
      preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: dtsxPath, offset: 1, limit: 20 },
      }))
      preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: dtsxPath, offset: 21, limit: 20 },
      }))
      preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: dtsxPath, offset: 41, limit: 20 },
      }))

      // 4th sequential range request
      const event = makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: dtsxPath, offset: 61, limit: 20 },
      })
      const out = preReadHandler(event)
      expectHookType(out, 'deny')
      expect(out.message).toContain('Sequential line-range paging detected on')
      expect(out.message).toContain('Inspect structure directly without manual chunk paging')
      expect(out.message).toContain('token-goat xml-outline')
      expect(out.message).toContain('token-goat xml-query')
    })
  })
})

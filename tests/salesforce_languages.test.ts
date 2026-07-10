import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseFile } from '../src/parser.js'
import { extractApex } from '../src/languages/apex.js'
import { extractSalesforceMetadata } from '../src/languages/salesforce_metadata.js'

function tmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-salesforce-test-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

describe('apex adapter', () => {
  it('extracts Apex classes, constructors, methods, and inner classes', () => {
    const content = `public with sharing class ExampleController {
  public static final String DEFAULT_VALUE = 'x';

  public ExampleController() {}

  @AuraEnabled(cacheable=true)
  public static String getValue(Id recordId) {
    return DEFAULT_VALUE;
  }

  global static Result getURL(Context ctx,
      String returnUrl) {
    return null;
  }

  public class InnerDto {
    public String name;
  }
}
`

    const { symbols } = extractApex(content, 'ExampleController.cls')
    const find = (name: string, kind: string) =>
      symbols.find((s) => s.name === name && s.kind === kind)

    expect(find('ExampleController', 'apex_class')?.lineEnd).toBe(19)
    expect(find('ExampleController', 'apex_constructor')?.lineStart).toBe(4)
    expect(find('getValue', 'apex_method')?.lineStart).toBe(6)
    expect(find('getValue', 'apex_method')?.body).toContain('@AuraEnabled')
    expect(find('getURL', 'apex_method')?.body).toContain('String returnUrl')
    expect(find('InnerDto', 'apex_class')).toBeDefined()
  })

  it('extracts Apex triggers with their target object as context', () => {
    const content = `trigger ExampleTrigger on Example_Object__c (before insert, after update) {
  ExampleHandler.run(Trigger.new);
}
`

    const { symbols } = extractApex(content, 'ExampleTrigger.trigger')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({
      name: 'ExampleTrigger',
      kind: 'apex_trigger',
      lineStart: 1,
      lineEnd: 3,
      docstring: 'Example_Object__c',
    })
  })

  it('does not let a "//" inside a string literal (e.g. a URL) eat the rest of the line, including a method-closing brace', () => {
    // Before the fix, stripCstyleComments's `//` stripper ran BEFORE stripStringLiterals, so the
    // `//` inside 'https://example.com' was treated as a real line-comment opener and blanked
    // everything through end-of-line - including the `}` that closes getName. That made
    // findBlockEndLine keep scanning for a match past getOther's own braces, swallowing getOther's
    // declaration line inside getName's span and causing overlapsExisting to skip getOther entirely.
    const content = `public class UrlHolder {
  public String getName() {
    String url = 'https://example.com'; return 'name'; }

  public String getOther() {
    return 'other';
  }
}
`
    const { symbols } = extractApex(content, 'UrlHolder.cls')
    const find = (name: string, kind: string) =>
      symbols.find((s) => s.name === name && s.kind === kind)

    expect(find('getName', 'apex_method')?.lineEnd).toBe(3)
    expect(find('getOther', 'apex_method')).toBeDefined()
  })

  it('is used by parseFile for .cls files', async () => {
    const file = tmp(
      'ExampleService.cls',
      `public class ExampleService {
  public static void run() {}
}
`,
    )

    const result = await parseFile(file)
    expect(result.language).toBe('apex')
    expect(result.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(['ExampleService', 'run']))
  })
})

describe('salesforce metadata adapter', () => {
  it('extracts custom fields with local and object-qualified names', () => {
    const file = 'force-app/main/default/objects/Account/fields/Example_Field__c.field-meta.xml'
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Example_Field__c</fullName>
  <label>Example Field</label>
  <type>Text</type>
</CustomField>
`

    const names = extractSalesforceMetadata(content, file).symbols.map((s) => s.name)
    expect(names).toEqual(['Example_Field__c', 'Account.Example_Field__c'])
  })

  it('extracts platform events from CustomObject metadata', () => {
    const file = 'force-app/main/default/objects/Example_Event__e/Example_Event__e.object-meta.xml'
    const content = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <eventType>HighVolume</eventType>
  <label>Example Event</label>
</CustomObject>
`

    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'Example_Event__e', kind: 'sf_platform_event' })
  })

  it('extracts validation rules with object context and qualified alias', () => {
    const file =
      'force-app/main/default/objects/Example_Object__c/validationRules/Example_Rule.validationRule-meta.xml'
    const content = `<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Example_Rule</fullName>
  <active>true</active>
  <errorConditionFormula>AND(ISCHANGED(Name), NOT($Permission.Example_Bypass))</errorConditionFormula>
</ValidationRule>
`

    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols.map((s) => [s.name, s.kind, s.docstring])).toEqual([
      ['Example_Rule', 'sf_validation_rule', 'Example_Object__c'],
      ['Example_Object__c.Example_Rule', 'sf_validation_rule', 'Example_Object__c'],
    ])
  })

  it('extracts flow top-level and element names', () => {
    const file = 'force-app/main/default/flows/Example_Flow.flow-meta.xml'
    const content = `<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <actionCalls>
    <name>Do_Action</name>
    <label>Do Action</label>
  </actionCalls>
  <assignments>
    <name>Set_Value</name>
    <label>Set Value</label>
  </assignments>
  <decisions>
    <name>Check_Value</name>
    <label>Check Value</label>
  </decisions>
</Flow>
`

    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols.map((s) => [s.name, s.kind])).toEqual([
      ['Example_Flow', 'sf_flow'],
      ['Do_Action', 'sf_flow_action'],
      ['Set_Value', 'sf_flow_assignment'],
      ['Check_Value', 'sf_flow_decision'],
    ])
    expect(symbols.find((s) => s.name === 'Do_Action')?.docstring).toBe('Example_Flow')
  })

  it('extracts permission sets and custom metadata record full names', () => {
    const permissionSet = extractSalesforceMetadata(
      `<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Example Permission Set</label>
</PermissionSet>
`,
      'force-app/main/default/permissionsets/Example_Permission_Set.permissionset-meta.xml',
    ).symbols
    const customMetadata = extractSalesforceMetadata(
      `<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Example Record</label>
</CustomMetadata>
`,
      'force-app/main/default/customMetadata/Example_Type.Example_Record.md-meta.xml',
    ).symbols

    expect(permissionSet[0]).toMatchObject({
      name: 'Example_Permission_Set',
      kind: 'sf_permission_set',
    })
    expect(customMetadata[0]).toMatchObject({
      name: 'Example_Type.Example_Record',
      kind: 'sf_custom_metadata_record',
    })
  })

  it('does not duplicate whole metadata files in symbol bodies', () => {
    const content = `<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userPermissions><enabled>true</enabled><name>ExamplePermission</name></userPermissions>
</Profile>
`
    const [symbol] = extractSalesforceMetadata(
      content,
      'force-app/main/default/profiles/Example.profile-meta.xml',
    ).symbols

    expect(symbol).toMatchObject({
      name: 'Example',
      kind: 'sf_profile',
      lineStart: 1,
      lineEnd: 3,
      body: '',
    })
  })
})

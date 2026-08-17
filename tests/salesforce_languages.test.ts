import { describe, expect, it } from 'vitest'

import { extractApex } from '../src/languages/apex.js'
import { extractSalesforceMetadata } from '../src/languages/salesforce_metadata.js'

import { parseFixture } from './helpers/parse-fixture.js'

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
    expect(find('InnerDto', 'apex_class')?.lineStart).toBe(16)
    expect(find('InnerDto', 'apex_class')?.lineEnd).toBe(18)
  })

  it('extracts a constructor with no access modifier at all (regression: METHOD_RE requires either a modifier or a return-type token, but a constructor - legal Apex, modifier omission defaults to private - has neither, so it was silently dropped from the index while a sibling explicit-modifier constructor in the same class was found)', () => {
    const content = `public class Foo {
  Integer x;

  Foo() {
    this.x = 1;
  }

  public Foo(Integer x) {
    this.x = x;
  }
}
`

    const { symbols } = extractApex(content, 'Foo.cls')
    const find = (name: string, kind: string) =>
      symbols.find((s) => s.name === name && s.kind === kind)

    const ctors = symbols.filter((s) => s.kind === 'apex_constructor')
    expect(ctors).toHaveLength(2)
    expect(find('Foo', 'apex_constructor')?.lineStart).toBe(4)
  })

  it('extracts a method with no access modifier at all (regression: METHOD_RE required at least one modifier, so an implicitly-private helper method - legal Apex, modifier omission defaults to private - was silently dropped from the index)', () => {
    const content = `public class MyClass {
  void helperMethod(String input) {
    System.debug(input);
  }

  public void publicMethod() {
    System.debug('ok');
  }
}
`

    const { symbols } = extractApex(content, 'MyClass.cls')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('helperMethod')
    expect(names).toContain('publicMethod')
  })

  it('extracts a class annotated with a same-line annotation, without swallowing the class header into the following method\'s span (regression: TYPE_DECL_RE had no leading-annotation allowance unlike METHOD_RE, so `@IsTest private class MyTestClass { ... }` silently dropped the class from the index; separately, annotationStartLine treated any line starting with @ as a foldable annotation line, so once the class itself indexed, an un-annotated method right after an annotated class header incorrectly walked its span back into the class\'s own header line)', () => {
    const content = `@IsTest private class MyTestClass {
  static void testMethod1() {
    System.assert(true);
  }
}
`

    const { symbols } = extractApex(content, 'MyTestClass.cls')
    expect(symbols.find((s) => s.name === 'MyTestClass')?.kind).toBe('apex_class')
    const method = symbols.find((s) => s.name === 'testMethod1')
    expect(method?.lineStart).toBe(2)
    expect(method?.body).not.toContain('@IsTest')
  })

  it('extracts a class annotated with a standalone annotation line above the declaration (regression: TYPE_DECL_RE/TRIGGER_RE only folded a same-line leading annotation into the span via annotationStartLine-equivalent handling on constructors/methods, not on class/interface/enum/trigger declarations -- `@IsTest` on its own line above `public class Foo { ... }`, the idiomatic Apex test-class style, was silently excluded from the class symbol\'s lineStart/body)', () => {
    const content = `@IsTest
public class MyTestClass {
  static void testMethod1() {
    System.assert(true);
  }
}
`

    const { symbols } = extractApex(content, 'MyTestClass.cls')
    const cls = symbols.find((s) => s.name === 'MyTestClass')
    expect(cls?.kind).toBe('apex_class')
    expect(cls?.lineStart).toBe(1)
    expect(cls?.body).toContain('@IsTest')
  })

  it('folds a multi-line annotation argument list into the annotated method\'s span (regression: annotationStartLine only recognized a standalone annotation as foldable when the whole line, including a balanced same-line paren pair, matched PURE_ANNOTATION_LINE_RE in one shot - an annotation whose argument list spans multiple physical lines, idiomatic for `@InvocableMethod(label=..., description=...)`, never matched that per-line regex on any of its lines, so the fold-back stopped immediately and silently dropped the whole annotation from the method\'s lineStart/body)', () => {
    const content = `public class MyFlowAction {
  @InvocableMethod(
    label='Do something'
    description='Runs the process'
  )
  public static void execute() {
    System.debug('run');
  }
}
`

    const { symbols } = extractApex(content, 'MyFlowAction.cls')
    const method = symbols.find((s) => s.name === 'execute')
    expect(method?.lineStart).toBe(2)
    expect(method?.body).toContain('@InvocableMethod')
    expect(method?.body).toContain("label='Do something'")
  })

  it('folds a multi-line annotation whose own string argument contains a literal unbalanced paren (regression: annotationStartLine counted `(`/`)` on the raw, unstripped source line, so a literal paren inside an annotation argument string like `label=\'Do something (\'` desynced the depth tracker and broke the walk-back early, silently dropping the whole annotation fold - the fix must count parens on the string/comment-blanked `code` text instead)', () => {
    const content = `public class MyFlowAction {
  @InvocableMethod(
    label='Do something ('
    description='Runs the process'
  )
  public static void execute() {
    System.debug('run');
  }
}
`

    const { symbols } = extractApex(content, 'MyFlowAction.cls')
    const method = symbols.find((s) => s.name === 'execute')
    expect(method?.lineStart).toBe(2)
    expect(method?.body).toContain('@InvocableMethod')
  })

  it('extracts an interface annotated with a same-line annotation (regression: same TYPE_DECL_RE gap as the class case above)', () => {
    const content = `@SuppressWarnings('PMD') public interface MyIntf {
  void doThing();
}
`

    const { symbols } = extractApex(content, 'MyIntf.cls')
    expect(symbols.find((s) => s.name === 'MyIntf')?.kind).toBe('apex_interface')
    // Regression: annotationStartLine's multi-line-annotation-opener branch used to fire even
    // when depth was already 0 on entry (not resuming a prior fold), so a fully self-contained,
    // balanced-paren same-line annotation on the interface's OWN header (with unrelated trailing
    // declaration content, e.g. `@SuppressWarnings('PMD') public interface MyIntf {`) was
    // misread as opening a multi-line annotation and folded into doThing's span, pulling
    // doThing's lineStart back to line 1 instead of its real declaration line 2.
    const doThing = symbols.find((s) => s.name === 'doThing' && s.kind === 'apex_method')
    expect(doThing).toBeDefined()
    expect(doThing?.lineStart).toBe(2)
    expect(doThing?.lineEnd).toBe(2)
  })

  it('extracts every method signature in an interface, which never carries an access modifier (regression: same METHOD_RE gap, but total - every Apex interface method is modifier-less by language rule, so this dropped 100% of interface methods)', () => {
    const content = `public interface MyInterface {
  void doSomething(String input);
  Integer calculate(Integer a, Integer b);
}
`

    const { symbols } = extractApex(content, 'MyInterface.cls')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('doSomething')
    expect(names).toContain('calculate')
  })

  it('does not mistake a plain no-modifier statement call inside a method body for a new method declaration (regression guard: relaxing METHOD_RE modifier group to zero-or-more, with no brace-depth tracking in this whole-file matchAll extractor, would otherwise let `someHelper(input);` or `return calculate(a, b);` inside a real method body match as their own phantom method)', () => {
    const content = `public class MyClass {
  public void doWork() {
    someHelper(1);
    anotherCall(2, 3);
    return calculate(4, 5);
  }

  private void someHelper(Integer x) {}
  private void anotherCall(Integer a, Integer b) {}
  private Integer calculate(Integer a, Integer b) {
    return a + b;
  }
}
`

    const { symbols } = extractApex(content, 'MyClass.cls')
    const methodSymbols = symbols.filter((s) => s.kind === 'apex_method')
    expect(methodSymbols).toHaveLength(4)
    const names = methodSymbols.map((s) => s.name).sort()
    expect(names).toEqual(['anotherCall', 'calculate', 'doWork', 'someHelper'])
  })

  it('extracts Apex triggers with their target object as context', () => {
    const content = `trigger ExampleTrigger on Example_Object__c (before insert, after update) {
  ExampleHandler.run(Trigger.new);
}
`

    const { symbols } = extractApex(content, 'ExampleTrigger.trigger')
    expect(symbols).toHaveLength(1)
    // The target object is a container/context label, not a doc comment -- it now lives in
    // `parent` (see db.ts's SCHEMA_SQL comment for why `docstring` no longer overloads this).
    expect(symbols[0]).toMatchObject({
      name: 'ExampleTrigger',
      kind: 'apex_trigger',
      lineStart: 1,
      lineEnd: 3,
      docstring: '',
      parent: 'Example_Object__c',
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
    expect(find('getOther', 'apex_method')?.lineStart).toBe(5)
    expect(find('getOther', 'apex_method')?.lineEnd).toBe(7)
  })

  it('does not let an apostrophe inside a "//" comment open a phantom string that swallows the rest of the file', () => {
    // Regression: extractApex runs stripStringLiterals(content) over the ENTIRE file content
    // (deliberately before comment-stripping, so a "//" inside a URL string literal survives
    // it), but stripStringLiterals used to blank every character - including newlines - until it
    // found the next matching quote once a string was considered "open". A stray apostrophe
    // inside a "//" line comment (e.g. "Don't") was misread as opening a real string, which then
    // swallowed every subsequent line's content: both methods below, and the class's true line
    // range, were lost.
    const content = `public class AccountService {
    // Don't call this directly
    public void MethodOne() {
        System.debug('one');
    }

    public void MethodTwo() {
        System.debug('two');
    }
}
`
    const { symbols } = extractApex(content, 'AccountService.cls')
    const find = (name: string, kind: string) => symbols.find((s) => s.name === name && s.kind === kind)

    expect(find('AccountService', 'apex_class')?.lineEnd).toBe(10)
    expect(find('MethodOne', 'apex_method')?.lineStart).toBe(3)
    expect(find('MethodOne', 'apex_method')?.lineEnd).toBe(5)
    expect(find('MethodTwo', 'apex_method')?.lineStart).toBe(7)
    expect(find('MethodTwo', 'apex_method')?.lineEnd).toBe(9)
  })

  it('does not let a semicolon-terminated abstract method swallow the next method body', () => {
    // Regression: METHOD_RE matches a declaration ending in either `{` or `;` (to capture
    // abstract/interface-style signatures), but spanForMatch always called findBlockEndLine,
    // which searches forward from the declaration for the next `{` in the file with no bound.
    // A brace-less declaration has none of its own, so the search found the FOLLOWING method's
    // opening brace instead, over-extending the abstract method's span to cover that method's
    // entire body - which then made overlapsExisting treat the following method as already
    // covered and drop it from the index outright.
    const content = `public abstract class Base {
    public abstract void doWork();
    public void helper() {
        System.debug('x');
    }
}
`
    const { symbols } = extractApex(content, 'Base.cls')
    const find = (name: string, kind: string) => symbols.find((s) => s.name === name && s.kind === kind)

    expect(find('doWork', 'apex_method')?.lineEnd).toBe(2)
    const helper = find('helper', 'apex_method')
    expect(helper).toBeDefined()
    expect(helper?.lineStart).toBe(3)
    expect(helper?.lineEnd).toBe(5)
  })

  it('does not drop interface method signatures because the interface\'s own span overlaps them', () => {
    // Regression: overlapsExisting only excluded the container kind 'apex_class' from its
    // overlap check, so a class's own whole-body span never suppressed its methods - but an
    // interface (or enum) type declaration is also a container span emitted by TYPE_DECL_RE, and
    // was missing from that exclusion. Every brace-less method signature inside an interface fell
    // within the interface's own [startLine, endLine] span and was silently dropped from the index.
    const content = `public interface MyIntf {
    public void methodA();
    public String methodB(Integer x);
}
`
    const { symbols } = extractApex(content, 'MyIntf.cls')
    const names = symbols.map((s) => s.name)

    expect(names).toContain('MyIntf')
    expect(names).toContain('methodA')
    expect(names).toContain('methodB')
    expect(symbols.find((s) => s.name === 'methodA')?.kind).toBe('apex_method')
    expect(symbols.find((s) => s.name === 'methodB')?.kind).toBe('apex_method')
  })

  it('indexes a method whose opening brace is on the next line, and the one after it (regression: the parameter-list scan was lazy and the `{` had to share the line with the `)`, so an Allman-style header ran on to the FOLLOWING declaration\'s `) {` and consumed it -- the second method was silently absent from the index)', () => {
    const content = `public class X {\n  public void first()\n  {\n  }\n  public void second() {}\n}\n`
    const { symbols } = extractApex(content, 'X.cls')
    expect(symbols.filter((s) => s.kind === 'apex_method').map((s) => s.name)).toEqual(['first', 'second'])
  })

  it('indexes a trigger whose event list wraps across lines, and emits no phantom method for it (regression: the event list had to fit on one line, so the trigger went unindexed AND `on` read as a return type with the SObject as the name -- the file\'s only symbol was a method called `Account` that does not exist)', () => {
    const content = `trigger T on Account (\n  before insert,\n  after update\n) {\n}\n`
    const { symbols } = extractApex(content, 'T.trigger')
    expect(symbols.map((s) => ({ name: s.name, kind: s.kind }))).toEqual([{ name: 'T', kind: 'apex_trigger' }])
  })

  it('calls a method a method even when its name matches a type declared elsewhere in the file (regression: constructor classification asked only whether the name was in the file\'s set of type names, so `class Outer { class Inner { void Outer() {} } }` reported Inner\'s method as a constructor of Outer)', () => {
    const content = `public class Outer2 {\n  public class Inner {\n    public void Outer2() {}\n  }\n}\n`
    const { symbols } = extractApex(content, 'C.cls')
    expect(symbols.find((s) => s.lineStart === 3)).toMatchObject({ name: 'Outer2', kind: 'apex_method' })
  })

  it('still calls a real no-return-type declaration a constructor, so the return-type rule did not disable them', () => {
    const content = `public class Outer2 {\n  public Outer2() {}\n  public void doWork() {}\n}\n`
    const { symbols } = extractApex(content, 'C2.cls')
    expect(symbols.find((s) => s.lineStart === 2)).toMatchObject({ name: 'Outer2', kind: 'apex_constructor' })
    expect(symbols.find((s) => s.lineStart === 3)).toMatchObject({ name: 'doWork', kind: 'apex_method' })
  })

  it('is used by parseFile for .cls files', async () => {
    const result = await parseFixture(
      'ExampleService.cls',
      `public class ExampleService {
  public static void run() {}
}
`,
    )
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

  it('detects a platform event from the __e name suffix alone, with no <eventType> tag present (regression-coverage gap: isPlatformEvent is an OR of two independent arms -- name.endsWith("__e") and an <eventType> tag -- but every existing test only exercised the <eventType> arm)', () => {
    const file = 'force-app/main/default/objects/Example_Event__e/Example_Event__e.object-meta.xml'
    const content = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Example Event</label>
</CustomObject>
`

    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'Example_Event__e', kind: 'sf_platform_event' })
  })

  it('classifies a standard custom object (no __e suffix, no eventType tag) as sf_object rather than sf_platform_event', () => {
    const file = 'force-app/main/default/objects/Example_Object__c/Example_Object__c.object-meta.xml'
    const content = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Example Object</label>
</CustomObject>
`

    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'Example_Object__c', kind: 'sf_object' })
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

    // The owning object is a container/context label, not a doc comment -- it now lives in
    // `parent` (see db.ts's SCHEMA_SQL comment for why `docstring` no longer overloads this).
    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols.map((s) => [s.name, s.kind, s.parent])).toEqual([
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
    // The owning flow is a container/context label, not a doc comment -- it now lives in
    // `parent` (see db.ts's SCHEMA_SQL comment for why `docstring` no longer overloads this).
    expect(symbols.find((s) => s.name === 'Do_Action')?.parent).toBe('Example_Flow')
  })

  it('extracts a distinct ref for each of two same-named <field> filters inside one recordLookups block (regression-coverage gap: the running-cursor fix documented at this callsite -- guarding against a plain indexOf always resolving to the first occurrence and silently dropping the second, same-named field ref as a duplicate -- had no test)', () => {
    const file = 'force-app/main/default/flows/Get_Account.flow-meta.xml'
    const content = `<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <recordLookups>
    <name>Get_Account</name>
    <object>Account</object>
    <filters>
      <field>Status</field>
      <operator>EqualTo</operator>
    </filters>
    <filters>
      <field>Status</field>
      <operator>NotEqualTo</operator>
    </filters>
  </recordLookups>
</Flow>
`

    const refs = extractSalesforceMetadata(content, file).refs
    const statusRefs = refs.filter((r) => r.name === 'Account.Status')
    expect(statusRefs).toHaveLength(2)
    // Distinct source locations -- the whole point of the running cursor: two same-named
    // field refs must not collapse onto the same line/col (which emitRef would then dedupe).
    expect(statusRefs[0]?.line).not.toBe(statusRefs[1]?.line)
    expect(refs.map((r) => r.name)).toContain('Account')
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

  it('extracts an object-scoped record type with its object-qualified alias (regression-coverage gap: recordtype/fieldset/compactlayout/businessprocess/weblink/sharingreason all share this codepath but none had a test)', () => {
    const file =
      'force-app/main/default/objects/Example_Object__c/recordTypes/Example_Type.recordType-meta.xml'
    const content = `<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Example_Type</fullName>
  <label>Example Type</label>
  <active>true</active>
</RecordType>
`

    // The owning object is a container/context label, not a doc comment -- it now lives in
    // `parent` (see db.ts's SCHEMA_SQL comment for why `docstring` no longer overloads this).
    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols.map((s) => [s.name, s.kind, s.parent])).toEqual([
      ['Example_Object__c.Example_Type', 'sf_record_type', 'Example_Object__c'],
    ])
  })

  it('extracts custom labels from a .labels-meta.xml file, one symbol per <labels> block', () => {
    const file = 'force-app/main/default/labels/CustomLabels.labels-meta.xml'
    const content = `<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">
  <labels>
    <fullName>Example_Label_One</fullName>
    <value>First value</value>
  </labels>
  <labels>
    <fullName>Example_Label_Two</fullName>
    <value>Second value</value>
  </labels>
</CustomLabels>
`

    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols.map((s) => [s.name, s.kind])).toEqual([
      ['CustomLabels', 'sf_custom_labels'],
      ['Example_Label_One', 'sf_custom_label'],
      ['Example_Label_Two', 'sf_custom_label'],
    ])
  })

  it('extracts LWC targets and target-config properties from a .js-meta.xml file, deduped by name', () => {
    const file = 'force-app/main/default/lwc/exampleComponent/exampleComponent.js-meta.xml'
    const content = `<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
  <targets>
    <target>lightning__RecordPage</target>
    <target>lightning__AppPage</target>
  </targets>
  <targetConfigs>
    <targetConfig targets="lightning__RecordPage">
      <property name="exampleProp" type="String" />
    </targetConfig>
  </targetConfigs>
</LightningComponentBundle>
`

    const symbols = extractSalesforceMetadata(content, file).symbols
    const names = symbols.map((s) => [s.name, s.kind])
    expect(names).toEqual(
      expect.arrayContaining([
        ['lightning__RecordPage', 'sf_lwc_target'],
        ['lightning__AppPage', 'sf_lwc_target'],
        ['exampleProp', 'sf_lwc_property'],
      ]),
    )
  })

  it('extracts refs to the sObject and component a Lightning page targets (regression-coverage gap: extractSalesforceMetadata\'s refs output, and the flexipage/quickaction/messagechannel tag-ref branches specifically, had no test at all)', () => {
    const file = 'force-app/main/default/flexipages/Example_Page.flexipage-meta.xml'
    const content = `<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
  <sobjectType>Example_Object__c</sobjectType>
  <flexiPageRegions>
    <componentInstances>
      <componentName>exampleComponent</componentName>
    </componentInstances>
  </flexiPageRegions>
</FlexiPage>
`

    const refs = extractSalesforceMetadata(content, file).refs
    const names = refs.map((r) => r.name)
    expect(names).toContain('Example_Object__c')
    expect(names).toContain('exampleComponent')
  })

  it('names an Apex class metadata companion "<ClassName>.metadata" rather than its bare fullName (regression-coverage gap: the companionName fallback -- reached for .cls/.trigger/.page/etc-meta.xml files, which never carry their own <fullName> tag -- had no test)', () => {
    const file = 'force-app/main/default/classes/ExampleService.cls-meta.xml'
    const content = `<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <status>Active</status>
</ApexClass>
`

    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'ExampleService.metadata', kind: 'sf_apex_class' })
  })

  it('falls back to the file basename for an unrecognized metadata suffix with no <fullName> tag (regression-coverage gap: metadataArtifactName, the last-resort naming fallback for suffixes not covered by any earlier branch, had no test)', () => {
    const file = 'force-app/main/default/widgets/Example.widget-meta.xml'
    const content = `<Widget xmlns="http://soap.sforce.com/2006/04/metadata">
  <someProperty>value</someProperty>
</Widget>
`

    const symbols = extractSalesforceMetadata(content, file).symbols
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'Example', kind: 'sf_widget' })
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

import { describe, expect, it } from 'vitest'

import { extractSalesforceMetadata } from '../src/languages/salesforce_metadata.js'

describe('Salesforce metadata XML adapter', () => {
  it('indexes companion descriptors and unknown metadata with stable snake-case kinds', () => {
    const companion = extractSalesforceMetadata(
      '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>64.0</apiVersion></ApexClass>',
      'force-app/main/default/classes/Checkout.cls-meta.xml',
    )
    const future = extractSalesforceMetadata(
      '<?xml version="1.0"?><m:PermissionSetGroup xmlns:m="urn:test"><m:fullName>Sales &amp; Service</m:fullName></m:PermissionSetGroup>',
      'force-app/main/default/future/Fallback.future-meta.xml',
    )

    expect(companion.symbols).toEqual([
      expect.objectContaining({ name: 'Checkout.metadata', kind: 'sf_apex_class', body: '' }),
    ])
    expect(future.symbols).toEqual([
      expect.objectContaining({ name: 'Sales & Service', kind: 'sf_permission_set_group' }),
    ])
    expect(companion.refs).toEqual([])
  })

  it.each([
    ['recordTypes/Partner.recordType-meta.xml', 'RecordType', 'Partner', 'sf_record_type'],
    ['fieldSets/Summary.fieldSet-meta.xml', 'FieldSet', 'Summary', 'sf_field_set'],
    ['compactLayouts/Phone.compactLayout-meta.xml', 'CompactLayout', 'Phone', 'sf_compact_layout'],
    ['businessProcesses/Sales.businessProcess-meta.xml', 'BusinessProcess', 'Sales', 'sf_business_process'],
    ['webLinks/Portal.webLink-meta.xml', 'WebLink', 'Portal', 'sf_web_link'],
    ['sharingReasons/Support.sharingReason-meta.xml', 'SharingReason', 'Support', 'sf_sharing_reason'],
  ])('qualifies object member %s', (tail, root, member, kind) => {
    const result = extractSalesforceMetadata(
      `<${root} xmlns="urn:test"><fullName>${member}</fullName></${root}>`,
      `force-app/main/default/objects/Account/${tail}`,
    )

    expect(result.symbols.map(({ name, kind: actualKind }) => [name, actualKind])).toContainEqual([
      `Account.${member}`,
      kind,
    ])
  })

  it('indexes individual custom labels and decodes XML entities', () => {
    const result = extractSalesforceMetadata(
      `<CustomLabels xmlns="urn:test">
  <labels><fullName>First_Label</fullName><value>One</value></labels>
  <labels><fullName>Second_Label</fullName><value>Fish &amp; Chips</value></labels>
</CustomLabels>`,
      'force-app/main/default/labels/CustomLabels.labels-meta.xml',
    )

    expect(result.symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ['CustomLabels', 'sf_custom_labels'],
      ['First_Label', 'sf_custom_label'],
      ['Second_Label', 'sf_custom_label'],
    ])
  })

  it('extracts and deduplicates Flow references', () => {
    const result = extractSalesforceMetadata(
      `<Flow xmlns="urn:test">
  <actionCalls><name>Invoke</name><actionName>InvoiceService.create</actionName></actionCalls>
  <subflows><name>Child</name><flowName>Shared_Subflow</flowName></subflows>
  <recordLookups><name>Find</name><object>Account</object><filters><field>External_Id__c</field></filters></recordLookups>
  <recordUpdates><name>Update</name><object>Account</object><inputAssignments><field>Name</field></inputAssignments></recordUpdates>
</Flow>`,
      'force-app/main/default/flows/Checkout.flow-meta.xml',
    )

    expect(result.refs.map((ref) => ref.name)).toEqual([
      'InvoiceService.create',
      'Shared_Subflow',
      'Account',
      'Account.External_Id__c',
      'Account',
      'Account.Name',
    ])
    expect(result.refs.every((ref) => ref.line > 0 && ref.col >= 0 && ref.context !== '')).toBe(true)
  })

  it('indexes deduplicated LWC targets and target-config properties with surgical spans', () => {
    const result = extractSalesforceMetadata(
      `<LightningComponentBundle xmlns="urn:test">
  <targets>
    <target>lightning__RecordPage</target>
    <target>lightning__AppPage</target>
    <target>lightning__RecordPage</target>
  </targets>
  <targetConfigs>
    <targetConfig targets="lightning__RecordPage">
      <property name="recordId" type="String"/>
      <property name="recordId" type="String" />
      <property name="mode" type="String"></property>
    </targetConfig>
  </targetConfigs>
</LightningComponentBundle>`,
      'force-app/main/default/lwc/orderCard/orderCard.js-meta.xml',
    )

    expect(result.symbols.map(({ name, kind }) => [name, kind])).toEqual([
      ['orderCard.metadata', 'sf_lightning_component_bundle'],
      ['lightning__RecordPage', 'sf_lwc_target'],
      ['lightning__AppPage', 'sf_lwc_target'],
      ['recordId', 'sf_lwc_property'],
      ['mode', 'sf_lwc_property'],
    ])
    for (const symbol of result.symbols.slice(1)) {
      expect(symbol.body).not.toBe('')
      expect(symbol.lineEnd).toBeGreaterThanOrEqual(symbol.lineStart)
    }
  })

  it.each([
    [
      'pages/Home.flexiPage-meta.xml',
      '<FlexiPage xmlns="urn:test"><sobjectType>Account</sobjectType><componentName>c:AccountHero</componentName></FlexiPage>',
      ['Account', 'c:AccountHero'],
    ],
    [
      'quickActions/Account.Start.quickAction-meta.xml',
      '<QuickAction xmlns="urn:test"><targetObject>Account</targetObject><lightningComponent>c:StartWizard</lightningComponent></QuickAction>',
      ['Account', 'c:StartWizard'],
    ],
    [
      'messageChannels/Order.messageChannel-meta.xml',
      '<LightningMessageChannel xmlns="urn:test"><masterLabel>Order</masterLabel><lightningMessageFields><fieldName>recordId</fieldName></lightningMessageFields></LightningMessageChannel>',
      ['recordId'],
    ],
  ])('extracts UI metadata references from %s', (tail, content, expected) => {
    const result = extractSalesforceMetadata(content, `force-app/main/default/${tail}`)
    expect(result.refs.map((ref) => ref.name)).toEqual(expected)
  })

  it('ignores metadata names, flow refs, and target-config properties inside XML comments', () => {
    const commentedName = extractSalesforceMetadata(
      `<CustomObject xmlns="urn:test">
  <!-- <fullName>Old_Object__c</fullName> -->
  <fullName>Real_Object__c</fullName>
</CustomObject>`,
      'force-app/main/default/objects/Real_Object__c/Real_Object__c.object-meta.xml',
    )
    expect(commentedName.symbols).toEqual([
      expect.objectContaining({ name: 'Real_Object__c', kind: 'sf_object' }),
    ])

    const commentedFlow = extractSalesforceMetadata(
      `<Flow xmlns="urn:test">
  <!-- <actionCalls><name>Disabled</name><actionName>OldService.create</actionName></actionCalls> -->
  <actionCalls><name>Invoke</name><actionName>InvoiceService.create</actionName></actionCalls>
</Flow>`,
      'force-app/main/default/flows/Checkout.flow-meta.xml',
    )
    expect(commentedFlow.symbols.map((symbol) => symbol.name)).not.toContain('Disabled')
    expect(commentedFlow.symbols.map((symbol) => symbol.name)).toContain('Invoke')
    expect(commentedFlow.refs.map((ref) => ref.name)).toEqual(['InvoiceService.create'])

    const commentedProperty = extractSalesforceMetadata(
      `<LightningComponentBundle xmlns="urn:test">
  <targetConfigs>
    <!-- <targetConfig targets="lightning__RecordPage"><property name="disabledProp" type="String"/></targetConfig> -->
    <targetConfig targets="lightning__RecordPage">
      <property name="recordId" type="String"/>
    </targetConfig>
  </targetConfigs>
</LightningComponentBundle>`,
      'force-app/main/default/lwc/orderCard/orderCard.js-meta.xml',
    )
    expect(commentedProperty.symbols.map((symbol) => symbol.name)).not.toContain('disabledProp')
    expect(commentedProperty.symbols.map((symbol) => symbol.name)).toContain('recordId')
  })

  it('returns no entries for malformed metadata and caps duplicate child symbols', () => {
    expect(
      extractSalesforceMetadata('<CustomLabels><labels><fullName>Broken', 'Broken.labels-meta.xml'),
    ).toEqual({ symbols: [], refs: [] })

    const repeated = Array.from(
      { length: 1100 },
      (_, index) => `<labels><fullName>Label_${index}</fullName></labels>`,
    ).join('')
    const result = extractSalesforceMetadata(
      `<CustomLabels>${repeated}<labels><fullName>Label_0</fullName></labels></CustomLabels>`,
      'CustomLabels.labels-meta.xml',
    )
    expect(result.symbols).toHaveLength(1000)
    expect(new Set(result.symbols.map((symbol) => symbol.name)).size).toBe(1000)
  })

  it('indexes a metadata file whose root element is self-closing (regression: rootElement required a separate close tag, so a self-closing root indexed as zero symbols)', () => {
    const result = extractSalesforceMetadata(
      '<CustomObjectTranslation xmlns="http://soap.sforce.com/2006/04/metadata"/>',
      'Account.objectTranslation-meta.xml',
    )
    expect(result.symbols).toEqual([
      expect.objectContaining({ name: 'Account', kind: 'sf_custom_object_translation' }),
    ])
  })

  it('caps ref emission at MAX_REFS instead of growing unbounded (regression: emitRef had no cap, unlike emit’s MAX_SYMBOLS)', () => {
    const repeated = Array.from(
      { length: 1100 },
      (_, index) => `<flexiPageRegion><componentInstance><componentName>cmp_${index}</componentName></componentInstance></flexiPageRegion>`,
    ).join('')
    const result = extractSalesforceMetadata(
      `<FlexiPage>${repeated}</FlexiPage>`,
      'Test.flexipage-meta.xml',
    )
    expect(result.refs.length).toBeLessThanOrEqual(1000)
  })
})

import { describe, expect, it } from 'vitest'

import {
  extractLwcJavaScript,
  extractLwcTemplate,
  extractSalesforceMarkup,
} from '../src/languages/salesforce_frontend.js'

describe('Salesforce frontend adapters', () => {
  it('indexes an LWC bundle, public API, and Salesforce imports', () => {
    const source = `import { LightningElement, api } from 'lwc';
import getRows from '@salesforce/apex/OrderController.getRows';
import ACCOUNT_NAME from '@salesforce/schema/Account.Name';
import TITLE from '@salesforce/label/c.Order_Title';
import LOGO from '@salesforce/resourceUrl/companyLogo';
import EVENTS from '@salesforce/messageChannel/OrderEvents__c';
import CAN_EDIT from '@salesforce/customPermission/Can_Edit_Order';
import VIEW_SETUP from '@salesforce/userPermission/ViewSetup';

export default class OrderList extends LightningElement {
  @api recordId;

  @api
  refresh() {}
}
`

    const result = extractLwcJavaScript(source, 'force-app/main/default/lwc/orderList/orderList.js')

    expect(result.symbols.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'orderList', kind: 'lwc_bundle' },
      { name: 'c-order-list', kind: 'lwc_component_alias' },
      { name: 'recordId', kind: 'lwc_api_property' },
      { name: 'refresh', kind: 'lwc_api_method' },
    ])
    expect(result.refs.map(({ name, line }) => ({ name, line }))).toEqual([
      { name: 'OrderController', line: 2 },
      { name: 'OrderController.getRows', line: 2 },
      { name: 'Account.Name', line: 3 },
      { name: 'c.Order_Title', line: 4 },
      { name: 'companyLogo', line: 5 },
      { name: 'OrderEvents__c', line: 6 },
      { name: 'Can_Edit_Order', line: 7 },
      { name: 'ViewSetup', line: 8 },
    ])
  })

  it('classifies public LWC accessors as properties and async functions as methods', () => {
    const source = `export default class StatusPanel {
  @api get status() { return 'ready'; }
  @api async reload() {}
}`
    const result = extractLwcJavaScript(source, 'force-app/main/default/lwc/statusPanel/statusPanel.js')
    expect(result.symbols.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'statusPanel', kind: 'lwc_bundle' },
      { name: 'c-status-panel', kind: 'lwc_component_alias' },
      { name: 'status', kind: 'lwc_api_property' },
      { name: 'reload', kind: 'lwc_api_method' },
    ])
  })

  it('indexes LWC template refs, event handlers, child components, and useful ids without SLDS classes', () => {
    const source = `<template>
  <section id="checkout-panel" class="slds-grid slds-p-around_medium" lwc:ref="panel">
    <lightning-button onclick={handleCheckout}></lightning-button>
    <c-order-row onremove={handleRemove}></c-order-row>
    <c-order-row></c-order-row>
  </section>
</template>`

    const result = extractLwcTemplate(source, 'force-app\\main\\default\\lwc\\checkoutPanel\\checkoutPanel.html')

    expect(result.symbols.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'panel', kind: 'lwc_ref' },
      { name: 'checkout-panel', kind: 'lwc_id' },
    ])
    expect(result.refs.map(({ name, line }) => ({ name, line }))).toEqual([
      { name: 'handleCheckout', line: 3 },
      { name: 'handleRemove', line: 4 },
      { name: 'c-order-row', line: 4 },
      { name: 'c-order-row', line: 5 },
    ])
  })

  it('indexes Aura bundles, members, controller actions, and component references', () => {
    const source = `<aura:component controller="OrderController">
  <aura:attribute name="recordId" type="Id"/>
  <aura:handler name="init" value="{!this}" action="{!c.load}"/>
  <aura:registerEvent name="changed" type="c:OrderChanged"/>
  <c:OrderRow onselect="{!c.select}"/>
</aura:component>`

    const result = extractSalesforceMarkup(source, 'force-app/main/default/aura/orderPanel/orderPanel.cmp')

    expect(result.symbols.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'orderPanel', kind: 'aura_bundle' },
      { name: 'recordId', kind: 'aura_attribute' },
      { name: 'init', kind: 'aura_handler' },
      { name: 'changed', kind: 'aura_event' },
    ])
    expect(result.refs.map(({ name, line }) => ({ name, line }))).toEqual([
      { name: 'OrderController', line: 1 },
      { name: 'load', line: 3 },
      { name: 'select', line: 5 },
      { name: 'c:OrderChanged', line: 4 },
      { name: 'c:OrderRow', line: 5 },
    ])
  })

  it('indexes Aura design attributes and Visualforce controller, extension, action, and component refs', () => {
    const design = extractSalesforceMarkup(
      '<design:component><design:attribute name="title" label="Title"/></design:component>',
      'force-app/main/default/aura/orderPanel/orderPanel.design',
    )
    expect(design.symbols.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'orderPanel', kind: 'aura_design' },
      { name: 'title', kind: 'aura_design_attribute' },
    ])

    const source = `<apex:page controller="OrderPageController" extensions="AuditExtension, SharingExtension" action="{!prepare}">
  <c:OrderSummary />
</apex:page>`
    const page = extractSalesforceMarkup(source, 'force-app/main/default/pages/Order.page')
    expect(page.symbols.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'Order', kind: 'visualforce_page' },
    ])
    expect(page.refs.map(({ name, line }) => ({ name, line }))).toEqual([
      { name: 'OrderPageController', line: 1 },
      { name: 'AuditExtension', line: 1 },
      { name: 'SharingExtension', line: 1 },
      { name: 'prepare', line: 1 },
      { name: 'c:OrderSummary', line: 2 },
    ])
  })

  it.each([
    ['cmp', 'aura_bundle'],
    ['app', 'aura_application'],
    ['evt', 'aura_event_bundle'],
    ['intf', 'aura_interface'],
    ['design', 'aura_design'],
    ['auradoc', 'aura_documentation'],
    ['tokens', 'aura_tokens'],
    ['page', 'visualforce_page'],
    ['component', 'visualforce_component'],
    ['email', 'visualforce_email_template'],
  ])('recognizes Salesforce markup extension .%s', (extension, kind) => {
    const isAura = ['cmp', 'app', 'evt', 'intf', 'design', 'auradoc', 'tokens'].includes(extension)
    const fileName = extension === 'page' ? 'Invoice.PAGE' : `sample.${extension}`
    const filePath = isAura
      ? `force-app/main/default/aura/sample/${fileName}`
      : `force-app/main/default/pages/${fileName}`
    const result = extractSalesforceMarkup('<root/>', filePath)
    expect(result.symbols[0]).toMatchObject({
      name: extension === 'page' ? 'Invoice' : 'sample',
      kind,
    })
  })
})

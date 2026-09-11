// HAND-DERIVED: standard Lightning Web Component JavaScript written from language knowledge, not from any adapter regex.
import { LightningElement, api } from 'lwc';
import loadAccount from '@salesforce/apex/AccountController.loadAccount';
import NAME_FIELD from '@salesforce/schema/Account.Name';

export default class AccountCard extends LightningElement {
  @api recordId;

  @api
  refresh() {
    return loadAccount({ recordId: this.recordId, fields: [NAME_FIELD] });
  }
}

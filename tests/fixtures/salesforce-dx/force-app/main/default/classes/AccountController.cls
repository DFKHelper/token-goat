public with sharing class AccountController {
  @AuraEnabled(cacheable=true)
  public static Account loadAccount(Id recordId) {
    return [SELECT Id, Name FROM Account WHERE Id = :recordId];
  }
}

public class SafeNavigationService {
  public Boolean beforeNavigation(Account account) {
    return account != null;
  }

  // Don't let comment punctuation hide this method or anything after it.
  private Boolean hasDirectName(Account account) {
    return String.isBlank(account?.Name);
  }

  private Boolean hasRelatedName(Account account) {
    return String.isBlank(account?.Parent?.Name);
  }

  private void logRelatedName(Account account) {
    System.debug(account?.Parent?.Name);
  }

  public void finishWork() {
    System.debug('finished');
  }

  public void afterFinish() {
    System.debug('after');
  }

  public void finalMethod() {
    System.debug('complete');
  }
}

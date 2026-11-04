export function accountGrantContext(accountId: string): string {
  return 'account:' + accountId + ':grant';
}

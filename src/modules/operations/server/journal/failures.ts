import type { ErrorCode } from '../../../../shared/contracts/http';

const failureMessages: Partial<Record<ErrorCode, string>> = {
  reconnect_required: 'reconnect this google account to continue.',
  permission_required: 'this account needs the requested google permission.',
  provider_rate_limited: 'google is limiting requests. this work will wait before retrying.',
  list_limit_reached: 'this work needs available list capacity.',
  storage_unavailable: 'this work could not be recorded. its confirmed output is retained.',
  conflict: 'the resource changed. inspect its current values before continuing.',
  outcome_uncertain:
    'google may have accepted this change. inspect its result before repeating it.',
  not_found: 'this resource could not be found at its recorded address.',
  forbidden: 'this account is not allowed to make this change.',
  validation_failed: 'check the submitted fields before continuing.',
  destination_removed:
    'the destination board was removed after dispatch. the confirmed list was preserved on the main board and unsent remaining work was stopped.',
  owner_stopped:
    'you kept the current google values and stopped applying this intent. its original provider outcome and receipt remain recorded.',
};

export const failureMessage = (code: ErrorCode) =>
  failureMessages[code] ?? 'this work could not finish. its confirmed output is retained.';

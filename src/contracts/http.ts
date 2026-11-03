export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation_failed'
  | 'conflict'
  | 'not_found'
  | 'reconnect_required'
  | 'permission_required'
  | 'list_limit_reached'
  | 'provider_rate_limited'
  | 'storage_unavailable'
  | 'provider_unavailable'
  | 'outcome_uncertain'
  | 'installation_unavailable'
  | 'internal_error'
  | 'rate_limited'
  | 'owner_stopped'
  | 'destination_removed';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    operationId?: string;
    retryable: boolean;
    fields?: Record<string, string>;
  };
}

export interface Coverage {
  complete: boolean;
  lastSyncedAt: string | null;
  stale: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  coverage: Coverage;
}

import type { ErrorCode } from '../../../../shared/contracts/http';

export type OperationState =
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'reconnect_required'
  | 'blocked_by_limit'
  | 'uncertain'
  | 'failed'
  | 'cancelled';

export interface OperationRecord {
  id: string;
  accountId: string;
  ownerSubject: string;
  kind: string;
  resourceKey: string;
  inputHash: string;
  input: unknown;
  state: OperationState;
  result: unknown;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  totalSteps: number;
  confirmedSteps: number;
  inputSealed: boolean;
  finished: boolean;
}

export interface OperationAdmission {
  id: string;
  accountId: string;
  ownerSubject: string;
  kind: string;
  resourceKey: string;
  input: unknown;
  steps: readonly { key: string; kind: string; input: unknown }[];
  listSlots?: number;
  totalSteps?: number;
}

export interface OperationStep {
  operationId: string;
  key: string;
  kind: string;
  input: unknown;
  state: string;
  claimId: string | null;
  claimUntil: number | null;
  response: unknown;
  result: unknown;
  listSlot: number;
  position: number;
}

export interface ClaimedStep extends OperationStep {
  mode: 'dispatch' | 'repair';
}

export interface ResolutionEvidence {
  kind: 'owner_candidate' | 'provider_readback';
  providerId: string;
  etag?: string;
  digest?: string;
}

export interface ResolveUnknownResponse {
  operationId: string;
  accountId: string;
  stepKey: string;
  expectedClaimId: string;
  response: unknown;
  evidence: ResolutionEvidence;
}

export interface StopRecordedIntent {
  operationId: string;
  accountId: string;
  stepKey: string;
  expectedClaimId: string | null;
  expectedResponse: unknown | null;
  evidence: ResolutionEvidence;
  decision: 'keep_provider_current';
}

export interface StoppedIntent {
  stepKey: string;
  expectedClaimId: string | null;
  expectedResponseHash: string | null;
  evidence: ResolutionEvidence;
  decision: 'keep_provider_current';
  createdAt: number;
}

export interface Row {
  id: string;
  account_id: string;
  owner_subject: string;
  kind: string;
  resource_key: string;
  input_hash: string;
  input_json: string;
  state: OperationState;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  cancel_requested: number;
  total_steps: number;
  confirmed_steps: number;
  input_sealed: number;
  terminal_at: number | null;
}

export interface StepRow {
  operation_id: string;
  item_key: string;
  kind: string;
  input_json: string;
  state: string;
  claim_id: string | null;
  claim_until: number | null;
  response_json: string | null;
  result_json: string | null;
  list_slot: number;
  position: number;
}

export interface StepRejection {
  code: ErrorCode;
  /** Only a transport/provider classification can establish this; a timeout cannot. */
  definitelyRejected: boolean;
  operationState?: 'failed' | 'reconnect_required' | 'blocked_by_limit';
  retryAt?: number;
}

const parseJson = (value: string | null): unknown => (value === null ? null : JSON.parse(value));

export const record = (row: Row): OperationRecord => ({
  id: row.id,
  accountId: row.account_id,
  ownerSubject: row.owner_subject,
  kind: row.kind,
  resourceKey: row.resource_key,
  inputHash: row.input_hash,
  input: parseJson(row.input_json),
  state: row.state,
  result: parseJson(row.result_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  cancelRequested: !!row.cancel_requested,
  totalSteps: row.total_steps,
  confirmedSteps: row.confirmed_steps,
  inputSealed: !!row.input_sealed,
  finished: row.terminal_at !== null,
});

export const stepRecord = (row: StepRow): OperationStep => ({
  operationId: row.operation_id,
  key: row.item_key,
  kind: row.kind,
  input: parseJson(row.input_json),
  state: row.state,
  claimId: row.claim_id,
  claimUntil: row.claim_until,
  response: parseJson(row.response_json),
  result: parseJson(row.result_json),
  listSlot: row.list_slot,
  position: row.position,
});

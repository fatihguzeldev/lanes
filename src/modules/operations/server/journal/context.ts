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

export interface StepRejection {
  code: ErrorCode;
  /** Only a transport/provider classification can establish this; a timeout cannot. */
  definitelyRejected: boolean;
  operationState?: 'failed' | 'reconnect_required' | 'blocked_by_limit';
  retryAt?: number;
}

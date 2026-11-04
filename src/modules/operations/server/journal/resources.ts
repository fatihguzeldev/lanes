import type { D1PreparedStatement } from '@cloudflare/workers-types';

export interface OperationSqlCondition {
  sql: string;
  bindings: (string | number)[];
}
export interface OperationListCapacity {
  known: number | null;
  reserved: number;
  available: number | null;
  stale: boolean;
}
/** Prepared list-resource writes join the journal's batch; they never commit independently. */
export interface OperationListReservations {
  capacity(accountId: string, now?: number): Promise<OperationListCapacity>;
  validate(steps: readonly { kind: string }[], slots: number, sealed: boolean): void;
  slotFor(kind: string): number;
  admissionCondition(accountId: string, slots: number, now: number): OperationSqlCondition;
  reserveWrite(
    input: { id: string; accountId: string },
    slots: number,
    now: number,
    inputHash: string,
  ): D1PreparedStatement;
  explainAdmissionFailure(accountId: string, slots: number, now: number): Promise<never>;
  releaseUnsealedWrite(id: string, accountId: string): D1PreparedStatement;
  releaseRejectedWrite(id: string): D1PreparedStatement;
  releaseFinishedWrite(id: string): D1PreparedStatement;
  stopWrites(accountId: string, operationId: string): D1PreparedStatement[];
  cancelWrite(id: string): D1PreparedStatement;
  confirmWrites(id: string, key: string): D1PreparedStatement[];
  sealCondition(id: string): OperationSqlCondition;
  cleanup(cutoff: number, remaining: number): Promise<{ meta: { changes: number } }>;
}
/** Fixed server-owned predicates retain receipts while their captured task input is needed. */
export interface OperationCaptureRetention {
  readonly receiptJoin: string;
  readonly payloadPrunable: string;
  readonly captureAbsent: string;
}
export interface OperationResources {
  lists: OperationListReservations;
  captures: OperationCaptureRetention;
}

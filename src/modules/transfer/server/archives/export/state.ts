import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../../shared/contracts/errors';
import type { Coverage } from '../../../../../shared/contracts/http';
import type { ArchiveRecord } from '../../../contracts/archive';
import type { ArchiveExportSummary } from '../../../contracts/archive-export';

export interface Run {
  id: string;
  account_id: string;
  request_json: string;
  request_hash: string;
  header_json: string;
  state: ArchiveExportSummary['state'];
  phase: ArchiveExportSummary['phase'];
  cursor: string | null;
  revision: number;
  record_count: number;
  bytes: number;
  task_count: number;
  list_count: number;
  unmatched_schedules: number;
  graph_revision: number | null;
  freshness_json: string | null;
  capture_hash: string;
  error_code: string | null;
  payload_pruned_at: number | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface SavedRecord {
  item_key: string;
  position: number;
  kind: ArchiveRecord['kind'];
  source_id: string;
  input_json: string;
  input_hash: string;
  byte_count: number;
}

export interface Job {
  item_key: string;
  kind: 'board_lists' | 'template' | 'schedule';
  source_id: string;
  source_kind: 'list' | 'board' | null;
  source_version: number | null;
  state: string;
  cursor: string | null;
  payload_json: string;
  snapshot_id: string | null;
  pin_owner: string | null;
  required: number;
}

export interface NewJob {
  key: string;
  kind: Job['kind'];
  sourceId: string;
  sourceKind?: 'list' | 'board';
  version?: number;
  payload?: unknown;
  required?: boolean;
}

export interface Captured {
  record: ArchiveRecord;
  sourceId: string;
}

export interface Progress {
  phase?: Run['phase'];
  cursor?: string | null;
  graphRevision?: number;
  freshness?: Coverage;
  jobs?: NewJob[];
  job?: {
    key: string;
    state: string;
    cursor?: string | null;
    payload?: unknown;
    snapshotId?: string | null;
    pinOwner?: string | null;
  };
  extra?: D1PreparedStatement[];
  unmatched?: number;
}

export const conflict = (
  message = 'the archive source changed while being captured; start a new export',
) => new AppError('conflict', message, 409);

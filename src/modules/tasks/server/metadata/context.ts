import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { HistoryService } from '../../../history/server/events/event-store';
import type { Priority } from '../../contracts/task';

export interface MetadataContext {
  operationId: string;
  stepKey: string;
  origin: 'owner' | 'scheduled';
  recordedAt: string;
  scheduleId?: string | undefined;
  runId?: string | undefined;
}

export interface TaskMetadataOptions {
  commitWrites(writes: D1PreparedStatement[]): Promise<unknown>;
  history: Pick<HistoryService, 'eventWrite'>;
}

export interface MetadataPatchResult {
  taskId: string;
  revision: number;
  graphRevision: number;
}

export interface PreparedMetadataPatch {
  writes: D1PreparedStatement[];
  result: MetadataPatchResult;
}

export interface CreatedTaskMetadata {
  taskId: string;
  expectedTaskRevision: number;
  labelIds: string[];
  priority: Priority;
  starred: boolean;
  blockedBy: string[];
}

import { AppError } from '../../../../shared/contracts/errors';
import type { HistoryEventInput } from '../../../history/contracts/events';
import type { ArchiveField, ArchiveRecord } from '../../contracts/archive';

export interface ActionRow {
  archive_id: string;
  item_key: string;
  phase: string;
  operation_id: string;
  input_json: string;
  state: string;
  result_json: string | null;
}

export type LocalAction = {
  kind: string;
  id?: string | undefined;
  revision?: number | undefined;
  input?: unknown;
  source?: ArchiveRecord;
  templateId?: string;
  snapshotId?: string;
  fields?: ArchiveField[];
  targetId?: string;
  position?: number;
  event?: HistoryEventInput;
};

export const conflict = (
  message = 'the selected destination changed after preview. inspect its current values before choosing incoming data again.',
) => new AppError('conflict', message, 409);

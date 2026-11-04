import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { MetadataContext } from '../metadata/context';
import type { ListSnapshotStore } from './snapshots';

export interface TemplateContext extends MetadataContext {
  saveDay: string;
  zone: string;
}

export interface SnapshotSourceList {
  sourceListId: string;
  revision: number;
  color: string;
  position: number;
}

export interface CaptureSnapshotOptions {
  dateMode: 'relative' | 'none';
  includeCompleted: boolean;
  saveDay: string;
  zone: string;
  recordedAt: string;
  snapshotId?: string;
  guardWrites?: D1PreparedStatement[];
}

export interface ListTemplateOptions {
  sourceListAppearance(
    accountId: string,
    listId: string,
  ): Promise<{
    color: string;
    guardWrites: D1PreparedStatement[];
    verifySource?(): Promise<void>;
  }>;
  snapshots: ListSnapshotStore;
  commitWrites(writes: D1PreparedStatement[]): Promise<unknown>;
  onDeleteWrites?(accountId: string, templateId: string): D1PreparedStatement[];
}

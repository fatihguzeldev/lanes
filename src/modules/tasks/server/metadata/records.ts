import type { Priority } from '../../contracts/task';

export interface TaskRow {
  id: string;
  account_id: string;
  list_id: string;
  title: string;
  list_title: string;
  priority: Priority;
  starred: number;
  revision: number;
  deleted_at: number | null;
  labels_json: string;
  blockers_json: string;
}

export interface LabelRow {
  id: string;
  account_id: string;
  name: string;
  name_key: string;
  color: string;
  revision: number;
}

export interface JobRow {
  id: string;
  account_id: string;
  label_id: string;
  label_name: string;
  state: 'pending' | 'completed';
  removed_associations: number;
  revision: number;
  created_at: number;
  completed_at: number | null;
}

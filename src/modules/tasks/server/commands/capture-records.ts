export interface Capture {
  operation_id: string;
  account_id: string;
  owner_subject: string;
  request_json: string;
  capture_nonce: string;
  resource_key: string;
  list_slots: number;
  total_steps: number;
  created_at: number;
  copy_context_json?: string | null;
  request_hash?: string | null;
  payload_pruned_at?: number | null;
}

export interface SavedStep {
  item_key: string;
  position: number;
  kind: string;
  input_json: string;
}

export const fields =
  'operation_id,account_id,owner_subject,request_json,capture_nonce,resource_key,list_slots,total_steps,created_at';

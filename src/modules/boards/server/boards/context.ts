import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
export interface BoardServiceOptions {
  assertLocalWritable(accountId: string): Promise<void>;
  commitWrites?(writes: D1PreparedStatement[]): Promise<D1Result[]>;
  onDeleteWrites?(accountId: string, boardId: string): D1PreparedStatement[];
}

import type { D1Database } from '@cloudflare/workers-types';
import type { BoardQueries } from '../../../boards/server/boards/queries';
import type { ArchiveHeader, ArchiveRecord } from '../../contracts/archive';
import { transferDigest } from '../identity/content-hash';
import type { ArchiveRow } from './archive-store';
import { conflict } from './restore-state';

export class ArchiveRestoreSource {
  constructor(
    private readonly db: D1Database,
    private readonly boards: Pick<BoardQueries, 'getMainBoard'>,
  ) {}
  async stable(row: ArchiveRow, key: string, prefix: string) {
    const header = JSON.parse(row.header_json) as ArchiveHeader;
    return (
      prefix +
      '-' +
      (await transferDigest(header.source.googleSubject + ':' + header.id + ':' + key)).slice(0, 32)
    );
  }

  async read(row: ArchiveRow, key: string): Promise<ArchiveRecord> {
    const value = await this.db
      .prepare('SELECT input_json FROM transfer_archive_records WHERE archive_id=? AND item_key=?')
      .bind(row.id, key)
      .first<string>('input_json');
    if (!value) throw conflict('a captured archive reference is missing.');
    return JSON.parse(value) as ArchiveRecord;
  }

  async targetBoard(row: ArchiveRow, key: string): Promise<string> {
    const board = await this.read(row, key);
    if (board.kind !== 'board') throw conflict('the captured destination is not a board.');
    return board.isMain
      ? (await this.boards.getMainBoard(row.account_id)).id
      : this.stable(row, key, 'archive-board');
  }
}

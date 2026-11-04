import type { D1Database } from '@cloudflare/workers-types';
import { randomToken } from '../credentials/crypto';
import { installationError } from '../errors';

export interface InstallationRow {
  owner_subject: string | null;
  bootstrap_email: string;
  owner_generation: string;
  token_key_id: string;
}

export class InstallationStore {
  constructor(
    private readonly db: D1Database,
    private readonly ownerEmail: string,
    private readonly tokenKeyId: string,
    private readonly clock: () => number,
  ) {}
  async read(): Promise<InstallationRow> {
    const query =
      'SELECT owner_subject,bootstrap_email,owner_generation,token_key_id FROM accounts_installation WHERE id=1';
    let row = await this.db.prepare(query).first<InstallationRow>();
    if (!row) {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO accounts_installation
        (id,bootstrap_email,owner_generation,token_key_id,created_at) VALUES (1,?,?,?,?)`,
        )
        .bind(this.ownerEmail, randomToken(), this.tokenKeyId, this.clock())
        .run();
      row = await this.db.prepare(query).first<InstallationRow>();
    }
    if (
      !row ||
      row.bootstrap_email !== this.ownerEmail ||
      row.token_key_id !== this.tokenKeyId ||
      !row.owner_generation
    )
      throw installationError();
    return row;
  }
}

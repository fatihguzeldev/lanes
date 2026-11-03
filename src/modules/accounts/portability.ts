import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../contracts/errors';
import { AccountPreferencesSchema } from './contracts';
import { localWriteGuard } from './access';
export interface PortableAccountIdentity {
  googleSubject: string;
  email: string;
  planningZone: string;
  weekStart: 1 | 7;
  revision: number;
}
/** Internal server capability. Composition authorizes the owner; this never exposes a grant. */
export class AccountsPortability {
  constructor(private readonly db: D1Database) {}
  async identity(accountId: string): Promise<PortableAccountIdentity> {
    const row = await this.db
      .prepare(
        'SELECT google_subject,email,planning_zone,week_start,revision FROM accounts_connections WHERE id=?',
      )
      .bind(accountId)
      .first<{
        google_subject: string;
        email: string;
        planning_zone: string;
        week_start: 1 | 7;
        revision: number;
      }>();
    if (!row)
      throw new AppError('not_found', 'the explicitly mapped account is no longer available.', 404);
    return {
      googleSubject: row.google_subject,
      email: row.email,
      planningZone: row.planning_zone,
      weekStart: row.week_start,
      revision: row.revision,
    };
  }
  async preparePreferencesRestore(
    accountId: string,
    input: unknown,
  ): Promise<D1PreparedStatement[]> {
    const value = AccountPreferencesSchema.safeParse(input);
    if (!value.success)
      throw new AppError(
        'validation_failed',
        'restore only a valid planning zone and week start with their current revision.',
        422,
      );
    return [
      localWriteGuard(this.db, accountId),
      this.db
        .prepare(
          'INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM accounts_connections WHERE id=? AND revision=?)',
        )
        .bind(accountId, value.data.revision),
      this.db
        .prepare(
          'UPDATE accounts_connections SET planning_zone=COALESCE(?,planning_zone),week_start=COALESCE(?,week_start),revision=revision+1 WHERE id=? AND revision=?',
        )
        .bind(
          value.data.planningZone ?? null,
          value.data.weekStart ?? null,
          accountId,
          value.data.revision,
        ),
    ];
  }
}

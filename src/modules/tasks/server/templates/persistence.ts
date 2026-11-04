import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
export function guard(db: D1Database, condition: string, values: unknown[]): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
    .bind(...values);
}

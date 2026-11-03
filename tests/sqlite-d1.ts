import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';
import { assertD1FunctionArguments } from './sqlite-constraints';

/** Real SQLite transactions behind the subset of D1 used by repository tests. */
export function testDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(`${directory}/${file}`, 'utf8'));
  }
  const result = (sql: string, values: unknown[]) => {
    const statement = sqlite.prepare(sql);
    const args = values as (string | number | null | Uint8Array)[];
    const rows = statement.columns().length ? statement.all(...args) : [];
    if (!statement.columns().length) statement.run(...args);
    const changes = sqlite.prepare('SELECT changes() AS n').get()?.n as number;
    return {
      success: true,
      results: rows,
      meta: { changes, duration: 0, rows_read: rows.length, rows_written: changes },
    };
  };
  class Prepared {
    constructor(
      readonly sql: string,
      readonly values: unknown[] = [],
    ) {}
    bind(...values: unknown[]) {
      if (values.length > 100) throw new Error('D1 permits at most100 bound parameters.');
      return new Prepared(this.sql, values);
    }
    async first(column?: string) {
      const row = result(this.sql, this.values).results[0] ?? null;
      return column && row ? row[column] : row;
    }
    async all() {
      return result(this.sql, this.values);
    }
    async run() {
      return result(this.sql, this.values);
    }
    async raw() {
      return result(this.sql, this.values).results.map((row) => Object.values(row));
    }
  }
  const db = {
    prepare(sql: string) {
      assertD1FunctionArguments(sql);
      return new Prepared(sql);
    },
    async batch(statements: Prepared[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const output = statements.map((statement) => result(statement.sql, statement.values));
        sqlite.exec('COMMIT');
        return output;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
  return { db, sqlite, close: () => sqlite.close() };
}

export async function seedAccount(db: D1Database, id = 'account-a', now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO accounts_connections
    (id,google_subject,email,display_name,state,created_at,updated_at)
    VALUES (?,?,?,?,'connected',?,?)`,
    )
    .bind(id, `subject-${id}`, `${id}@example.com`, id, now, now)
    .run();
  await db
    .prepare('INSERT INTO tasks_account_state(account_id,inventory_complete_at) VALUES (?,?)')
    .bind(id, now)
    .run();
  return id;
}

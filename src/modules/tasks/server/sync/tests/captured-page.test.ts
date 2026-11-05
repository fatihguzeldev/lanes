import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { captureTaskPage, retainedTaskPage } from '../captured-page';

describe('captured provider page bounds', () => {
  it('retains only projection inputs from a provider observation', () => {
    const page = captureTaskPage({
      items: [
        {
          id: 'task',
          title: 'task',
          selfLink: 'https://example.com',
          links: [{ link: 'https://example.com' }],
        },
      ],
      nextPageToken: 'next',
    });
    expect(page).toEqual({
      version: 1,
      items: [{ id: 'task', title: 'task' }],
      nextPageToken: 'next',
    });
    expect(
      retainedTaskPage(
        { page_json: JSON.stringify(page), page_offset: 0, page_projection_revision: 3 },
        3,
      ),
    ).toEqual({ page, offset: 0 });
    expect(
      retainedTaskPage(
        { page_json: JSON.stringify(page), page_offset: 0, page_projection_revision: 3 },
        4,
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: 'too many tasks',
      items: Array.from({ length: 26 }, (_, index) => ({ id: String(index) })),
    },
    { name: 'duplicate identities', items: [{ id: 'same' }, { id: 'same' }] },
    { name: 'oversized content', items: [{ id: 'task', notes: 'a'.repeat(1_500_000) }] },
  ])('rejects $name before projection or a checkpoint write', ({ items }) => {
    expect(() => captureTaskPage({ items, nextPageToken: null })).toThrow(
      'google returned a task page that could not be retained safely',
    );
  });

  it('adds a bounded checkpoint without changing a queued pre-migration provider cursor', () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      const old = readFileSync(
        new URL('../../../../../../migrations/0004_sync.sql', import.meta.url),
        'utf8',
      );
      const definition = old.match(/CREATE TABLE tasks_sync_list_work \([\s\S]*?\) STRICT;/)?.[0];
      expect(definition).toBeDefined();
      sqlite.exec(
        "CREATE TABLE tasks_lists(account_id TEXT,id TEXT,PRIMARY KEY(account_id,id)) STRICT; INSERT INTO tasks_lists VALUES('account','list')",
      );
      sqlite.exec(definition!);
      sqlite.exec(
        "INSERT INTO tasks_sync_list_work(account_id,list_id,priority,next_at,mode,page_token,scan_id,started_at,updated_min) VALUES('account','list',0,1,'delta','provider-cursor','scan',1,'2026-11-02T12:00:00Z')",
      );
      sqlite.exec(
        readFileSync(
          new URL('../../../../../../migrations/0029_sync_pages.sql', import.meta.url),
          'utf8',
        ),
      );
      expect(sqlite.prepare('SELECT * FROM tasks_sync_list_work').get()).toMatchObject({
        account_id: 'account',
        list_id: 'list',
        priority: 0,
        next_at: 1,
        mode: 'delta',
        page_token: 'provider-cursor',
        scan_id: 'scan',
        started_at: 1,
        updated_min: '2026-11-02T12:00:00Z',
        page_json: null,
        page_offset: 0,
        page_projection_revision: null,
      });
      expect(() => sqlite.exec('UPDATE tasks_sync_list_work SET page_offset=26')).toThrow();
      expect(() =>
        sqlite.exec('UPDATE tasks_sync_list_work SET page_projection_revision=-1'),
      ).toThrow();
      expect(() =>
        sqlite.prepare('UPDATE tasks_sync_list_work SET page_json=?').run('invalid-json'),
      ).toThrow();
      expect(() =>
        sqlite
          .prepare('UPDATE tasks_sync_list_work SET page_json=?')
          .run(JSON.stringify('a'.repeat(1_500_000))),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });
});

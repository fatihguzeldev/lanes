import { describe, expect, it } from 'vitest';
import { HistoryEventSchema } from '../modules/history/contracts';
import { describeHistoryEvent } from './HistoryPanel';

const base = {
  id: 'event',
  accountId: 'account',
  taskId: 'task',
  listId: 'list',
  dedupKey: 'observation',
  origin: 'observed' as const,
  recordedAt: '2026-11-02T12:00:00Z',
  summary: { providerVersion: 'version' },
};
describe('history event presentation', () => {
  it('distinguishes source-preserving creation context from an external observation', () => {
    expect(
      describeHistoryEvent(HistoryEventSchema.parse({ ...base, kind: 'task_created' })),
    ).toMatchObject({ action: 'created', detail: '' });
    expect(
      describeHistoryEvent(
        HistoryEventSchema.parse({
          ...base,
          kind: 'task_created',
          origin: 'owner',
          summary: { operationId: 'operation', stepKey: 'item', source: 'transfer' },
        }),
      ),
    ).toMatchObject({ action: 'created', detail: 'from transfer' });
  });
  it('distinguishes list moves, nesting, and promotion without claiming an actor', () => {
    expect(
      describeHistoryEvent(
        HistoryEventSchema.parse({
          ...base,
          kind: 'task_moved',
          summary: {
            providerVersion: 'version',
            from: { listId: 'before', parentId: null },
            to: { listId: 'after', parentId: null },
          },
        }),
      ).detail,
    ).toBe('to another list');
    expect(
      describeHistoryEvent(
        HistoryEventSchema.parse({
          ...base,
          kind: 'task_moved',
          summary: {
            providerVersion: 'version',
            from: { listId: 'list', parentId: 'parent' },
            to: { listId: 'list', parentId: null },
          },
        }),
      ).detail,
    ).toBe('to the top level');
  });
  it('shows explicit day removal and an incomplete confirmed list deletion count', () => {
    expect(
      describeHistoryEvent(
        HistoryEventSchema.parse({
          ...base,
          kind: 'scheduled_day_changed',
          summary: { providerVersion: 'version', before: '2026-11-03', after: null },
        }),
      ),
    ).toMatchObject({ action: 'removed date', detail: '2026-11-03 → unscheduled' });
    expect(
      describeHistoryEvent(
        HistoryEventSchema.parse({
          ...base,
          taskId: null,
          kind: 'list_deleted',
          summary: { providerVersion: 'version', knownTaskCount: 7, coverageComplete: false },
        }),
      ).detail,
    ).toBe('7 observed tasks');
  });
});

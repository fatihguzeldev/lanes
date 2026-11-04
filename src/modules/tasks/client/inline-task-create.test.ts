import { describe, expect, it } from 'vitest';
import { captureInlineTask, inlineCreateWasRejected } from './inline-task-create';

describe('inline task creation', () => {
  it('captures a trimmed title and its original list revision before submission', () => {
    const list = { id: 'list-a', accountId: 'account-a', revision: 7 };
    const attempt = captureInlineTask(list, '  write the next section  ', () => 'attempt-a');
    list.revision = 8;
    expect(attempt).toMatchObject({
      accountId: 'account-a',
      identity: 'attempt-a',
      command: {
        kind: 'task.create',
        listId: 'list-a',
        listRevision: 7,
        title: 'write the next section',
        parentId: null,
        notes: '',
      },
    });
  });

  it('does not allocate a submission identity for an invalid title', () => {
    let allocated = false;
    expect(() =>
      captureInlineTask({ id: 'list', accountId: 'account', revision: 0 }, '   ', () => {
        allocated = true;
        return 'unused';
      }),
    ).toThrow('enter a title');
    expect(allocated).toBe(false);
  });

  it('keeps an uncertain or unreachable submission locked to its existing identity', () => {
    expect(inlineCreateWasRejected(null, 'server_unavailable', false)).toBe(false);
    expect(inlineCreateWasRejected(null, 'connection_paused', false)).toBe(true);
    expect(inlineCreateWasRejected(null, 'connection_paused', true)).toBe(false);
    expect(inlineCreateWasRejected({ state: 'uncertain', finished: false }, undefined, true)).toBe(
      false,
    );
    expect(inlineCreateWasRejected(null, 'conflict', true)).toBe(false);
    expect(inlineCreateWasRejected(null, 'conflict', false)).toBe(true);
    expect(inlineCreateWasRejected({ state: 'failed', finished: true }, undefined, true)).toBe(
      true,
    );
  });
});

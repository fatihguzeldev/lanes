import { describe, expect, it } from 'vitest';
import type { OperationSummary } from '../operation-contract';
import { RequestError } from '../../../shared/browser/http/http';
import { commandNeedsRefresh, commandRequestError } from './useCommands';

const receipt = (patch: Partial<OperationSummary> = {}): OperationSummary => ({
  id: '1730000000000:abcdefghijklmnop',
  accountId: 'account-a',
  kind: 'task.create',
  state: 'accepted',
  createdAt: 1,
  updatedAt: 1,
  cancelRequested: false,
  totalSteps: 1,
  confirmedSteps: 0,
  inputSealed: true,
  error: null,
  nextAttemptAt: null,
  finished: false,
  ...patch,
});

describe('command workspace updates', () => {
  it('keeps the workspace steady while an admitted change is waiting or running', () => {
    const accepted = receipt();
    const running = receipt({ state: 'running', updatedAt: 2 });
    expect(commandNeedsRefresh(null, accepted)).toBe(false);
    expect(commandNeedsRefresh(accepted, running)).toBe(false);
    expect(
      commandNeedsRefresh(running, receipt({ state: 'running', updatedAt: 3, nextAttemptAt: 50 })),
    ).toBe(false);
  });

  it('refreshes for newly confirmed output, without reloading on repeated partial polls', () => {
    const first = receipt({ state: 'partial', confirmedSteps: 1, totalSteps: 3 });
    expect(commandNeedsRefresh(receipt({ totalSteps: 3 }), first)).toBe(true);
    expect(commandNeedsRefresh(first, { ...first, updatedAt: 8 })).toBe(false);
    expect(commandNeedsRefresh(first, { ...first, confirmedSteps: 2 })).toBe(true);
  });

  it('refreshes once when work settles, including a partial outcome with no confirmed items', () => {
    const running = receipt({ state: 'running' });
    const stopped = receipt({ state: 'partial', finished: true });
    expect(commandNeedsRefresh(running, stopped)).toBe(true);
    expect(commandNeedsRefresh(stopped, { ...stopped, updatedAt: 4 })).toBe(false);
    expect(commandNeedsRefresh(null, receipt({ state: 'succeeded', finished: true }))).toBe(true);
  });

  it('refreshes for a newly paused outcome without treating every repeated receipt as a change', () => {
    const uncertain = receipt({ state: 'uncertain' });
    expect(commandNeedsRefresh(receipt({ state: 'running' }), uncertain)).toBe(true);
    expect(commandNeedsRefresh(uncertain, { ...uncertain, updatedAt: 5 })).toBe(false);
  });

  it('refreshes unfinished-save discovery when browser monitoring stops', () => {
    const waiting = receipt({ state: 'running' });
    expect(commandNeedsRefresh(waiting, waiting, true)).toBe(true);
    const done = receipt({ state: 'succeeded', finished: true });
    expect(commandNeedsRefresh(done, done, true)).toBe(false);
  });

  it('does not compare one command’s confirmed output with another command', () => {
    const previous = receipt({ state: 'succeeded', confirmedSteps: 1, finished: true });
    const next = receipt({
      id: '1730000000001:abcdefghijklmnop',
      state: 'partial',
      confirmedSteps: 1,
    });
    expect(commandNeedsRefresh(previous, next)).toBe(true);
  });
});

describe('command error recovery', () => {
  const identity = '1730000000000:abcdefghijklmnop';

  it('retains the submitted identity after a dropped response without exposing it in the message', () => {
    const error = commandRequestError(
      new RequestError('server_unavailable', 'unsent work'),
      identity,
    );
    expect(error.code).toBe('server_unavailable');
    expect(error.operationId).toBe(identity);
    expect(error.message).not.toContain(identity);
    expect(error.message).not.toContain('unsent');
    expect(error.message).toContain('check this change before trying again');
  });

  it('preserves a definite admission rejection so the editor can safely correct and retry it', () => {
    const rejected = new RequestError(
      'validation_failed',
      'enter a title',
      'request-a',
      undefined,
      {
        title: 'required',
      },
    );
    expect(commandRequestError(rejected, identity)).toBe(rejected);
    expect(commandRequestError(rejected, identity).operationId).toBeUndefined();
  });

  it('keeps an existing receipt identity and a reload instruction after an incompatible response', () => {
    const error = commandRequestError(
      new RequestError(
        'response_invalid',
        'reload lanes before making another change.',
        'request-a',
        identity,
      ),
      'another-submission',
    );
    expect(error.operationId).toBe(identity);
    expect(error.requestId).toBe('request-a');
    expect(error.message).toContain('reload lanes');
  });
});

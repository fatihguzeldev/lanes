import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskSchema, type Task } from '../../../contracts/task';
import { readCreatedTask } from '../creation-receipt';
const reads = vi.hoisted(() => ({ request: vi.fn(), task: vi.fn() }));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: reads.request }));
vi.mock('../../queries/references', () => ({ readTask: reads.task }));
const input = CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'ring64' });
const task = { ...input, id: 'real-task', revision: 1, completed: false } as Task;
const step = { kind: 'task.create', state: 'confirmed', taskId: 'real-task', deleted: false };
const page = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });
describe('confirmed creation address', () => {
  beforeEach(() => {
    reads.request.mockReset();
    reads.task.mockReset().mockResolvedValue(task);
  });
  it('resolves the public receipt before reading a real task, including later receipt pages', async () => {
    reads.request.mockResolvedValueOnce(page([], 'next')).mockResolvedValueOnce(page([step]));
    expect(await readCreatedTask('account', 'receipt', input)).toBe(task);
    expect(reads.request.mock.calls.map((call) => call[0])).toEqual([
      '/api/accounts/account/operations/receipt/steps',
      '/api/accounts/account/operations/receipt/steps?cursor=next',
    ]);
    expect(reads.task).toHaveBeenCalledWith('account', 'real-task');
  });
  it('publishes the verified receipt address before a slower task read settles', async () => {
    reads.request.mockResolvedValue(page([step]));
    let finish!: (value: Task) => void;
    reads.task.mockReturnValue(
      new Promise<Task>((resolve) => {
        finish = resolve;
      }),
    );
    const address = vi.fn();
    const reading = readCreatedTask('account', 'receipt', input, address);
    await Promise.resolve();
    expect(address).toHaveBeenCalledWith('real-task');
    finish(task);
    await reading;
  });
  it.each(['accepted', 'claimed', 'dispatched', 'uncertain', 'failed', 'cancelled'])(
    'never turns a %s step into a server task identity',
    async (state) => {
      reads.request.mockResolvedValue(page([{ ...step, state }]));
      await expect(readCreatedTask('account', 'receipt', input)).rejects.toThrow(
        'address is not available',
      );
      expect(reads.task).not.toHaveBeenCalled();
    },
  );
  it('does not use an unrelated or deleted receipt step', async () => {
    reads.request.mockResolvedValue(
      page([
        { ...step, kind: 'task.edit' },
        { ...step, deleted: true },
      ]),
    );
    await expect(readCreatedTask('account', 'receipt', input)).rejects.toThrow();
    expect(reads.task).not.toHaveBeenCalled();
  });
  it.each([{ accountId: 'other' }, { listId: 'other' }, { parentId: 'other' }, { id: 'other' }])(
    'verifies the confirmed address against its captured create scope %o',
    async (patch) => {
      reads.request.mockResolvedValue(page([step]));
      reads.task.mockResolvedValue({ ...task, ...patch });
      await expect(readCreatedTask('account', 'receipt', input)).rejects.toThrow(
        'address could not be verified',
      );
    },
  );
  it('rejects another account before reading any receipt', async () => {
    await expect(readCreatedTask('other', 'receipt', input)).rejects.toThrow('another account');
    expect(reads.request).not.toHaveBeenCalled();
  });
  it('stops malformed repeated receipt cursors', async () => {
    reads.request.mockResolvedValue(page([], 'same'));
    await expect(readCreatedTask('account', 'receipt', input)).rejects.toThrow(
      'receipt could not be read',
    );
    expect(reads.request).toHaveBeenCalledTimes(2);
  });
});

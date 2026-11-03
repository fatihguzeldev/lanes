import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFileInWorker } from './parser-client';
import { parseImportFile } from './parser';
import type { ImportWorkerRequest, ImportWorkerResult } from './parser.worker';

const instances: FakeWorker[] = [];
let created: () => void = () => {};
class FakeWorker {
  onmessage: ((event: MessageEvent<ImportWorkerResult>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  request: ImportWorkerRequest | undefined;
  transfer: Transferable[] | undefined;
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    instances.push(this);
    created();
  }
  postMessage(request: ImportWorkerRequest, transfer: Transferable[]) {
    this.request = request;
    this.transfer = transfer;
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  instances.splice(0);
  created = () => {};
});
function nextWorker(): Promise<void> {
  return new Promise((resolve) => {
    created = resolve;
  });
}
function install() {
  vi.stubGlobal('Worker', FakeWorker);
  return new File(['Task\none'], 'tasks.csv', { type: 'text/csv' });
}

describe('disposable browser import worker', () => {
  it('transfers bytes to a module worker and terminates it after the matching preview', async () => {
    const file = install(),
      ready = nextWorker();
    const result = parseFileInWorker(file);
    await ready;
    const worker = instances[0]!;
    expect(worker.url.pathname).toContain('/parser.worker.ts');
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.transfer).toEqual([worker.request?.file.bytes]);
    const preview = await parseImportFile({
      name: 'tasks.csv',
      bytes: new Uint8Array(worker.request!.file.bytes),
    });
    worker.onmessage?.({
      data: { id: worker.request!.id, ok: true, preview },
    } as MessageEvent<ImportWorkerResult>);
    expect((await result).tasks[0]?.title).toBe('one');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('terminates a running preview when the owner cancels', async () => {
    const file = install(),
      ready = nextWorker(),
      controller = new AbortController();
    const result = parseFileInWorker(file, {}, { signal: controller.signal });
    await ready;
    const assertion = expect(result).rejects.toMatchObject({ code: 'parse_cancelled' });
    controller.abort();
    await assertion;
    expect(instances[0]?.terminate).toHaveBeenCalledTimes(1);
  });
  it('terminates parsing at the selected time bound', async () => {
    vi.useFakeTimers();
    const file = install(),
      ready = nextWorker();
    const result = parseFileInWorker(file);
    await ready;
    const assertion = expect(result).rejects.toMatchObject({ code: 'parse_timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(instances[0]?.terminate).toHaveBeenCalledTimes(1);
  });
  it('rejects an already cancelled request without allocating a worker', async () => {
    const file = install(),
      controller = new AbortController();
    controller.abort();
    await expect(parseFileInWorker(file, {}, { signal: controller.signal })).rejects.toMatchObject({
      code: 'parse_cancelled',
    });
    expect(instances).toHaveLength(0);
  });
});

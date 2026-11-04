import { MAX_IMPORT_FILE_BYTES, TransferParseError } from '../../contracts/parsing';
import type { ImportOptions, ImportPreview } from '../../contracts/parsing';
import type { ImportWorkerRequest, ImportWorkerResult } from './parser.worker.ts';

/** One disposable worker per preview; timeout/cancellation terminates parsing and releases its source buffers. */
export async function parseFileInWorker(
  file: File,
  options: ImportOptions = {},
  control: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ImportPreview> {
  if (file.size > MAX_IMPORT_FILE_BYTES)
    throw new TransferParseError(
      'file_too_large',
      'a file may contain at most 20 mib. select a smaller export.',
    );
  const timeout = control.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
    throw new TransferParseError(
      'timeout_invalid',
      'choose a parser timeout between 1 and 30,000 milliseconds.',
    );
  if (control.signal?.aborted)
    throw new TransferParseError('parse_cancelled', 'the import preview was cancelled.');
  const bytes = await file.arrayBuffer();
  if (control.signal?.aborted)
    throw new TransferParseError('parse_cancelled', 'the import preview was cancelled.');
  const worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' }),
    id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: TransferParseError, preview?: ImportPreview) => {
      clearTimeout(timer);
      control.signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(preview!);
    };
    const abort = () =>
      finish(new TransferParseError('parse_cancelled', 'the import preview was cancelled.'));
    const timer = setTimeout(
      () =>
        finish(
          new TransferParseError(
            'parse_timeout',
            'this file exceeded the preview time limit. select a smaller range or convert it to csv.',
          ),
        ),
      timeout,
    );
    worker.onerror = () =>
      finish(
        new TransferParseError(
          'parse_failed',
          'the file parser stopped. try a smaller selection or convert it to csv.',
        ),
      );
    worker.onmessage = (event: MessageEvent<ImportWorkerResult>) => {
      const result = event.data;
      if (result.id !== id) return;
      if (result.ok) finish(undefined, result.preview);
      else finish(new TransferParseError(result.error.code, result.error.message));
    };
    control.signal?.addEventListener('abort', abort, { once: true });
    const request: ImportWorkerRequest = { id, file: { name: file.name, bytes }, options };
    try {
      worker.postMessage(request, [bytes]);
    } catch {
      finish(
        new TransferParseError(
          'request_invalid',
          'the import mapping could not be sent to the parser. choose plain field mappings.',
        ),
      );
    }
  });
}

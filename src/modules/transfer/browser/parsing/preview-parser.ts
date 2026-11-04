import {
  MAX_IMPORT_FILE_BYTES,
  type ImportOptions,
  type ImportPreview,
  type ImportTable,
} from '../../contracts/parsing';
import type { ArchiveDocument } from '../../contracts/archive';
type TransferParseRequest =
  | { kind: 'archive'; bytes: ArrayBuffer }
  | { kind: 'tables'; tables: ImportTable[]; options: ImportOptions };
export function parseTransferInWorker(
  input: { kind: 'archive'; file: File },
  signal: AbortSignal,
): Promise<ArchiveDocument>;
export function parseTransferInWorker(
  input: { kind: 'tables'; tables: ImportTable[]; options: ImportOptions },
  signal: AbortSignal,
): Promise<ImportPreview>;
export async function parseTransferInWorker(
  input:
    | { kind: 'archive'; file: File }
    | { kind: 'tables'; tables: ImportTable[]; options: ImportOptions },
  signal: AbortSignal,
): Promise<ArchiveDocument | ImportPreview> {
  if (input.kind === 'archive' && input.file.size > MAX_IMPORT_FILE_BYTES)
    throw new Error('an archive may contain at most 20 mib. select a narrower export.');
  const payload: TransferParseRequest =
    input.kind === 'archive' ? { kind: 'archive', bytes: await input.file.arrayBuffer() } : input;
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  const worker = new Worker(new URL('./transfer-parser.worker.ts', import.meta.url), {
    type: 'module',
  });
  return new Promise((resolve, reject) => {
    const end = (error?: Error, value?: ArchiveDocument | ImportPreview) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => end(new DOMException('aborted', 'AbortError'));
    const timeout = setTimeout(
      () =>
        end(
          new Error(
            'the preview exceeded 30 seconds. select a smaller range or convert it to csv.',
          ),
        ),
      30000,
    );
    worker.onerror = () =>
      end(new Error('the preview parser stopped. use a smaller source or a supported conversion.'));
    worker.onmessage = (
      event: MessageEvent<{ ok: boolean; value?: ArchiveDocument | ImportPreview; error?: string }>,
    ) => {
      if (event.data.ok) end(undefined, event.data.value);
      else end(new Error(event.data.error ?? 'this source could not be parsed safely.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.postMessage(payload, payload.kind === 'archive' ? [payload.bytes] : []);
  });
}

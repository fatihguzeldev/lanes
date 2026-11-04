import { z } from 'zod';
import { parseImportFile } from '../../parser';
import {
  ImportFormatSchema,
  MAX_IMPORT_FILE_BYTES,
  TransferParseError,
  importFields,
} from '../../parse-contract';
import type { ImportOptions, ImportPreview } from '../../parse-contract';

const mapping = z.partialRecord(z.enum(importFields), z.number().int().min(0).max(255));
export const ImportWorkerOptionsSchema = z
  .object({
    format: ImportFormatSchema.optional(),
    headerRow: z.number().int().min(1).max(10_000).optional(),
    mapping: mapping.optional(),
    mappingBySheet: z
      .array(
        z
          .object({
            sheet: z.string().min(1).max(4096),
            fields: mapping,
            headerRow: z.number().int().min(1).max(10_000).optional(),
          })
          .strict(),
      )
      .max(100)
      .refine((value) => new Set(value.map((entry) => entry.sheet)).size === value.length)
      .optional(),
    dateConvention: z.enum(['iso', 'day-first', 'month-first']).optional(),
    groupBy: z.enum(['sheet', 'list-column', 'single']).optional(),
    singleListTitle: z.string().min(1).max(4096).optional(),
    destination: z.enum(['new', 'existing']).optional(),
    skipCompleted: z.boolean().optional(),
    selections: z
      .array(
        z
          .object({
            sheet: z.string().min(1).max(4096),
            range: z.string().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    excludedRows: z
      .array(
        z
          .object({
            sheet: z.string().min(1).max(4096),
            rows: z.array(z.number().int().min(1).max(1_048_576)).max(10_000),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export interface ImportWorkerRequest {
  id: string;
  file: { name: string; bytes: ArrayBuffer };
  options?: ImportOptions;
}
export type ImportWorkerResult =
  | { id: string; ok: true; preview: ImportPreview }
  | { id: string; ok: false; error: { code: string; message: string } };

/** Parsing is read-only; this worker has no application HTTP or provider capabilities. */
export async function handleImportWorkerRequest(input: unknown): Promise<ImportWorkerResult> {
  const id =
    typeof input === 'object' && input && 'id' in input && typeof input.id === 'string'
      ? input.id.slice(0, 100)
      : '';
  try {
    const request = z
      .object({
        id: z.string().min(1).max(100),
        file: z
          .object({ name: z.string().min(1).max(4096), bytes: z.instanceof(ArrayBuffer) })
          .strict(),
        options: ImportWorkerOptionsSchema.optional(),
      })
      .strict()
      .safeParse(input);
    if (!request.success)
      throw new TransferParseError(
        'request_invalid',
        'the import preview request is invalid. select the file and mapping again.',
      );
    if (request.data.file.bytes.byteLength > MAX_IMPORT_FILE_BYTES)
      throw new TransferParseError(
        'file_too_large',
        'a file may contain at most 20 mib. select a smaller export.',
      );
    const options = request.data.options as ImportOptions | undefined;
    return {
      id,
      ok: true,
      preview: await parseImportFile(
        { name: request.data.file.name, bytes: new Uint8Array(request.data.file.bytes) },
        options,
      ),
    };
  } catch (error) {
    return {
      id,
      ok: false,
      error:
        error instanceof TransferParseError
          ? { code: error.code, message: error.message }
          : {
              code: 'parse_failed',
              message:
                'this file could not be parsed safely. try a smaller selection or convert it to utf-8 csv.',
            },
    };
  }
}
const worker = globalThis as typeof globalThis & {
  document?: unknown;
  postMessage?: (message: ImportWorkerResult) => void;
  onmessage?: ((event: MessageEvent<unknown>) => void) | null;
};
let busy = false;
if (typeof worker.postMessage === 'function' && typeof worker.document === 'undefined')
  worker.onmessage = (event) => {
    if (busy) {
      worker.postMessage?.({
        id: '',
        ok: false,
        error: { code: 'parser_busy', message: 'wait for the current import preview to finish.' },
      });
      return;
    }
    busy = true;
    void handleImportWorkerRequest(event.data)
      .then((result) => worker.postMessage?.(result))
      .finally(() => {
        busy = false;
      });
  };

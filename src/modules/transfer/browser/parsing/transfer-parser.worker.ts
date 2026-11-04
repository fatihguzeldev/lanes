import { parseWorkspaceArchive } from '../../formats/archive';
import { normalizeImportTables } from '../../formats/normalize';
import type { ImportOptions, ImportTable } from '../../contracts/parsing';
type Input =
  | { kind: 'archive'; bytes: ArrayBuffer }
  | { kind: 'tables'; tables: ImportTable[]; options: ImportOptions };
const worker = globalThis as typeof globalThis & {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<Input>) => void) | null;
};
worker.onmessage = (event) => {
  try {
    const input = event.data;
    worker.postMessage({
      ok: true,
      value:
        input.kind === 'archive'
          ? parseWorkspaceArchive(new Uint8Array(input.bytes))
          : normalizeImportTables(input.tables, 'csv', input.options),
    });
  } catch (error) {
    worker.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'the source could not be parsed safely.',
    });
  }
};

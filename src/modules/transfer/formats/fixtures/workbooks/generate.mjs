import * as XLSX from 'xlsx';
import numbers from 'xlsx/dist/xlsx.zahl.mjs';
import { writeFileSync } from 'node:fs';

// authored fixture values; no personal account export is used.
const rows = [
  ['Task', 'Notes', 'Due date', 'Completed'],
  ['write a note', 'line one\nline two', '2026-11-03', false],
  ['ship the draft', '', '', true],
];
for (const bookType of ['xlsx', 'xls', 'ods', 'numbers']) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Tasks');
  writeFileSync(new URL(`tasks.${bookType}`, import.meta.url), XLSX.write(workbook, { type: 'buffer', bookType, compression: true, ...(bookType === 'numbers' ? { numbers } : {}) }));
}

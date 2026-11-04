# parser fixtures

these fixtures contain small authored task examples. no fixture was downloaded from an owner's google account, personal export, or private document.

## text and takeout

`tasks.csv` and `tasks.tsv` exercise utf-8 byte-order marks and quoted multiline notes. `tasks.txt` and `tasks.md` exercise list headings, checkboxes, subtasks, and plain-text notes. their content was authored for lanes and follows the repository's license.

`Tasks.json` uses the takeout `tasks#taskLists` → `items` → `tasks#tasks` shape documented by the original [google tasks to obsidian converter](https://github.com/grantbarrett/google-tasks-to-obsidian-converter#input-format), published under CC0-1.0. the fixture values were authored here; no personal export was copied. `Tasks-taskList-kind.json` exercises the explicit `tasks#taskList` compatibility kind. unknown export versions fail instead of treating arbitrary json strings as tasks.

## workbooks

`workbooks/tasks.xlsx`, `workbooks/tasks.xls`, `workbooks/tasks.ods`, and `workbooks/tasks.numbers` contain the same authored rows. they are actual files in their respective formats, produced by the [official sheetjs community edition 0.20.3 distribution](https://cdn.sheetjs.com/). they are not a common file with renamed extensions.

`workbooks/generate.mjs` records how the files were made. run `node src/modules/transfer/formats/fixtures/workbooks/generate.mjs` after installing the locked dependencies to regenerate them.

sheetjs's numbers writer starts with the real working numbers file encoded in its `xlsx/dist/xlsx.zahl.mjs` payload and rewrites its table data. the resulting fixture contains numbers metadata and framed-snappy protobuf `.iwa` records. the payload and writer are distributed in the official Apache-2.0 package. its license is retained verbatim in `workbooks/LICENSE.sheetjs`. see the [official numbers export explanation](https://docs.sheetjs.com/docs/api/write-options/#numbers-exports). the fixture's task values were authored here; its blank template assets come from that licensed payload.

these fixtures prove parsing the represented variants. they do not establish compatibility with every historical workbook version. encrypted files and unsupported variants require an unencrypted values-only xlsx conversion.

## parsing boundaries

sheetjs 0.20.3 is pinned to the official versioned tarball because the npm registry's `xlsx` release is older. sheetjs supplies format parsing, including binary xls and numbers. its Apache-2.0 license is included above. the official `xlsx/dist/cpexcel.full.mjs` companion supplies legacy character encodings.

fflate 0.8.3 supplies bounded streaming deflate decoding under the MIT license. version 0.8.2 is not used because its zip64 parser had an infinite-loop advisory. production preflight walks checked zip entries and streams their actual output; it does not call `unzipSync`. the package lock records dependency integrity.

local workbooks run in a dedicated browser worker. values are read from caches without formula, macro, html, external-link, or script execution. a missing cached formula value becomes an unresolved cell warning. modern numbers formula indices receive a separate bounded check because sheetjs does not expose them. older numbers storage that cannot expose every formula receives an explicit preview warning.

the input limit is 20 mib. actual zip output and inner numbers snappy output share a 100 mib expansion limit. zip directories, protobuf packets, repeat counts, table dimensions, selected cell counts, and diagnostics also have explicit bounds. malformed or unsupported packets fail before sheetjs can silently skip them. a selection with too many diagnostics fails with `too_many_issues`; diagnostics are not truncated.

## csv text escapes

csv export prefixes textual cells with an apostrophe when the first character is `=`, `+`, `-`, `@`, whitespace/control, or an apostrophe. the canonical lanes csv importer removes this documented escape and emits a `csv_text_escape` preview warning. this prevents spreadsheet formula interpretation while making the transformation visible. csv is not an exact backup of arbitrary text; the workspace archive owns exact text preservation.

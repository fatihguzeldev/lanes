import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleImportWorkerRequest } from './parser.worker';
import {
  parseDelimitedText,
  parseImportFile,
  normalizeImportTables,
  formatCsvHeader,
  formatCsvTask,
} from './parser';
import {
  MAX_IMPORT_FILE_BYTES,
  NormalizedImportPlanSchema,
  TransferParseError,
} from './parse-contract';
const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (text: string, name = 'tasks.csv', options = {}) =>
  parseImportFile({ name, bytes: bytes(text) }, options);

describe('delimited preview and captured identities', () => {
  it('reads utf-8 BOM, quoted multiline fields and a selectable header row', async () => {
    const result = await parse(
      '\ufeffan introduction\r\nTask,Notes,List\r\n"write, carefully","first line\r\nsecond line 🪴",home\r\n,,\r\n',
      'tasks.csv',
      { headerRow: 2 },
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      key: 't1',
      title: 'write, carefully',
      notes: 'first line\r\nsecond line 🪴',
      listKey: 'l1',
    });
    expect(result.lists[0]?.title).toBe('home');
    expect(result.skippedBlankRows).toBe(1);
    expect(result.mapping[0]?.fields).toEqual({ task: 0, notes: 1, list: 2 });
  });

  it('supports tabs, escaped quotes, custom mappings and skips no nonblank data row', async () => {
    expect(parseDelimitedText('a\tb\n"x\"\"y"\t"line\none"', '\t')).toEqual([
      ['a', 'b'],
      ['x"y', 'line\none'],
    ]);
    const result = await parse('what\tdetails\ntrim me  \tplain notes', 'tasks.tsv', {
      mapping: { task: 0, notes: 1 },
    });
    expect(result.tasks[0]?.title).toBe('trim me');
    expect(result.tasks[0]?.notes).toBe('plain notes');
  });

  it('rejects malformed quoting, unsupported encodings and oversized files', async () => {
    expect(() => parseDelimitedText('Task\n"unfinished', ',')).toThrow(TransferParseError);
    expect(() => parseDelimitedText('Task\na"b', ',')).toThrow(TransferParseError);
    await expect(
      parseImportFile({ name: 'tasks.csv', bytes: new Uint8Array([0xff, 0xfe, 0x41]) }),
    ).rejects.toMatchObject({ code: 'encoding_unsupported' });
    await expect(
      parseImportFile({ name: 'tasks.csv', bytes: new Uint8Array(MAX_IMPORT_FILE_BYTES + 1) }),
    ).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(parse('anything', 'tasks.zip')).rejects.toMatchObject({
      code: 'format_unsupported',
    });
  });

  it('requires title mapping and detects duplicate automatic headers', async () => {
    const missing = await parse('anything,notes\nvalue,note');
    expect(missing.issues).toContainEqual(
      expect.objectContaining({ code: 'mapping_required', severity: 'error' }),
    );
    const duplicated = await parse('Task,Title\none,two');
    expect(duplicated.issues).toContainEqual(
      expect.objectContaining({ code: 'ambiguous_header', severity: 'error' }),
    );
  });

  it('rewrites export-local references and never exposes input provider ids as destination identities', async () => {
    const result = await parse(
      'source_key,parent_key,list,task,dependencies\nprovider-task-a,,work,parent,[]\nprovider-task-b,provider-task-a,work,child,"[""provider-task-a""]"',
    );
    expect(result.tasks[1]).toMatchObject({ key: 't2', parentKey: 't1', dependencies: ['t1'] });
    expect(JSON.stringify(result.tasks)).not.toContain('provider-task');
    expect(
      NormalizedImportPlanSchema.safeParse({ version: 1, tasks: result.tasks, lists: result.lists })
        .success,
    ).toBe(true);
  });

  it('reports missing parents, cycles, deep nesting and cross-list references', async () => {
    for (const text of [
      'source_key,parent_key,task\na,missing,a',
      'source_key,parent_key,task\na,b,a\nb,a,b',
      'source_key,parent_key,task\na,,a\nb,a,b\nc,b,c',
      'source_key,parent_key,task,list\na,,a,one\nb,a,b,two',
    ]) {
      const result = await parse(text);
      expect(
        result.issues.some(
          (issue) => issue.severity === 'error' && /hierarchy|parent/.test(issue.code),
        ),
      ).toBe(true);
    }
  });

  it('normalizes only contiguous legacy parent-title runs, keeping later equal titles distinct', async () => {
    const result = await parse(
      'Task,Subtask,List\nsame,child one,work\nsame,child two,work\nother,,work\nsame,child three,work',
    );
    expect(result.tasks.map((task) => [task.title, task.parentKey])).toEqual([
      ['same', null],
      ['child one', 't1'],
      ['child two', 't1'],
      ['other', null],
      ['same', null],
      ['child three', 't5'],
    ]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'legacy_parent_runs', severity: 'warning' }),
    );
  });

  it('does not infer a day/month convention and shows unknown optional values as row warnings', async () => {
    const source = 'Task,Due date,Completed,Priority\nambiguous,03/04/2026,maybe,urgent';
    const result = await parse(source);
    expect(result.tasks[0]?.scheduledDay).toBeNull();
    for (const code of ['date_convention_required', 'unknown_boolean', 'unknown_priority'])
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code, source: expect.objectContaining({ row: 2 }) }),
      );
    expect(
      (await parse(source, 'tasks.csv', { dateConvention: 'day-first' })).tasks[0]?.scheduledDay,
    ).toBe('2026-04-03');
    expect(
      (await parse(source, 'tasks.csv', { dateConvention: 'month-first' })).tasks[0]?.scheduledDay,
    ).toBe('2026-03-04');
  });

  it('validates schedule and structured metadata through owning schemas', async () => {
    const result = await parse(
      'Task,scheduled_day,scheduled_time,time_zone,labels,dependencies,repeat_rule\ninvalid,2026-11-03,09:30,Not/AZone,"[""home""]",not-json,not-json',
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_schedule', severity: 'warning' }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_structure',
        field: 'dependencies',
        severity: 'error',
      }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_structure',
        field: 'repeat_rule',
        severity: 'error',
      }),
    );
  });

  it('keeps required completed parent context open when skipping completed tasks', async () => {
    const result = await parse(
      'source_key,parent_key,Task,Completed\na,,parent,true\nb,a,child,false\nc,,done,true',
      'tasks.csv',
      { skipCompleted: true },
    );
    expect(result.tasks.map((task) => [task.title, task.completed])).toEqual([
      ['parent', false],
      ['child', false],
    ]);
    expect(result.parentContextCount).toBe(1);
    expect(result.skippedCompletedTasks).toBe(1);
  });

  it('supports sheet grouping, one new list and an explicit existing destination without title matching', () => {
    const tables = [
      {
        name: 'one',
        rows: [
          ['Task', 'List'],
          ['a', 'same'],
        ],
      },
      {
        name: 'two',
        rows: [
          ['Task', 'List'],
          ['b', 'same'],
        ],
      },
    ];
    expect(
      normalizeImportTables(tables, 'csv', { groupBy: 'sheet' }).lists.map((list) => list.title),
    ).toEqual(['one', 'two']);
    expect(
      normalizeImportTables(tables, 'csv', {
        groupBy: 'single',
        singleListTitle: 'chosen',
      }).lists.map((list) => list.title),
    ).toEqual(['chosen']);
    const existing = normalizeImportTables(tables, 'csv', { destination: 'existing' });
    expect(existing.lists).toHaveLength(1);
    expect(existing.issues).toContainEqual(
      expect.objectContaining({ code: 'list_grouping_ignored' }),
    );
  });

  it('fails the complete operation rather than truncating at task or list limits', async () => {
    await expect(
      parse('Task\n' + Array.from({ length: 2001 }, (_, i) => 'task ' + i).join('\n')),
    ).rejects.toMatchObject({ code: 'too_many_tasks' });
    await expect(
      parse('Task,List\n' + Array.from({ length: 101 }, (_, i) => 'task,list ' + i).join('\n')),
    ).rejects.toMatchObject({ code: 'too_many_lists' });
  });
});

describe('text and takeout', () => {
  it('reads list headings, one subtask level, completion and indented plain-text notes', async () => {
    const result = await parse(
      '# home\n- [ ] parent\n  parent note\n  - [x] child\n    child note\n- <script>plain text</script>',
      'tasks.md',
    );
    expect(result.lists[0]?.title).toBe('home');
    expect(result.tasks[0]?.notes).toBe('parent note');
    expect(result.tasks[1]).toMatchObject({
      parentKey: 't1',
      completed: true,
      completedAt: null,
      notes: 'child note',
    });
    expect(result.tasks[2]?.title).toBe('<script>plain text</script>');
  });

  it('rejects deeper text task nesting with a line reference', async () => {
    await expect(parse('- parent\n  - child\n    - grandchild', 'tasks.txt')).rejects.toMatchObject(
      { code: 'hierarchy_too_deep', message: expect.stringContaining('3') },
    );
  });

  it('accepts known Takeout taskLists shape and preserves hierarchy, dates, completion and notes', async () => {
    const result = await parse(
      JSON.stringify({
        kind: 'tasks#taskLists',
        items: [
          {
            kind: 'tasks#tasks',
            id: 'source-list',
            title: 'home',
            items: [
              {
                kind: 'tasks#task',
                id: 'source-parent',
                title: 'parent',
                notes: 'first\nsecond',
                due: '2026-11-03T00:00:00.000Z',
                status: 'completed',
                completed: '2026-11-01T10:00:00Z',
              },
              {
                kind: 'tasks#task',
                id: 'source-child',
                parent: 'source-parent',
                title: 'child',
                status: 'needsAction',
                selfLink: 'https://do-not-fetch.example',
              },
            ],
          },
        ],
      }),
      'Tasks.json',
    );
    expect(result.tasks[0]).toMatchObject({
      scheduledDay: '2026-11-03',
      completed: true,
      completedAt: '2026-11-01T10:00:00Z',
      notes: 'first\nsecond',
    });
    expect(result.tasks[1]?.parentKey).toBe('t1');
    expect(JSON.stringify(result.tasks)).not.toContain('source-parent');
  });

  it('rejects unknown JSON schemas instead of importing arbitrary string values', async () => {
    await expect(
      parse('{"kind":"tasks#future","items":["not a task"]}', 'Tasks.json'),
    ).rejects.toMatchObject({ code: 'takeout_schema_unsupported' });
  });
});

describe('safe incremental csv output', () => {
  it('round trips structured hierarchy and makes formula text escapes visible', async () => {
    const original = await parse(
      'source_key,parent_key,Task,Notes,starred\na,,parent,"=DO_NOT_EXECUTE()",true\nb,a,child,"@plain",false',
    );
    const csv =
      formatCsvHeader() + original.tasks.map((task) => formatCsvTask(task, 'home')).join('');
    expect(csv).toContain("'=DO_NOT_EXECUTE()");
    expect(csv).toContain("'@plain");
    const preview = await parse(csv);
    expect(preview.tasks[0]?.notes).toBe('=DO_NOT_EXECUTE()');
    expect(preview.tasks[1]?.parentKey).toBe('t1');
    expect(preview.issues).toContainEqual(
      expect.objectContaining({ code: 'csv_text_escape', severity: 'warning' }),
    );
  });
});

describe('fixtures and strict admission boundaries', () => {
  it.each([
    'tasks.csv',
    'tasks.tsv',
    'tasks.txt',
    'tasks.md',
    'Tasks.json',
    'Tasks-taskList-kind.json',
  ])('reads an authored representative %s fixture without provider calls', async (name) => {
    const fetcher = vi.fn(() => {
      throw new Error('no network during preview');
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const source = readFileSync(new URL('./fixtures/' + name, import.meta.url));
      const preview = await parseImportFile({ name, bytes: source });
      expect(preview.tasks.map((task) => task.title)).toEqual(['parent', 'child']);
      expect(preview.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts unicode by character count and reports over-limit fields', async () => {
    const okay = await parse('Task,Notes\n' + '🪴'.repeat(1024) + ',' + '🪴'.repeat(8192));
    expect(okay.issues).toEqual([]);
    const bad = await parse('Task,Notes\n' + '🪴'.repeat(1025) + ',' + '🪴'.repeat(8193));
    expect(bad.issues.map((issue) => issue.code)).toEqual(['title_too_long', 'notes_too_long']);
  });

  it('allows explicitly skipped completed rows without silently truncating selected open tasks', async () => {
    const source =
      'Task,Completed\n' +
      Array.from({ length: 2001 }, (_, index) => 'done ' + index + ',true').join('\n') +
      '\nopen,false';
    const result = await parse(source, 'tasks.csv', { skipCompleted: true });
    expect(result.tasks.map((task) => task.key)).toEqual(['t1']);
    expect(result.tasks[0]?.title).toBe('open');
    expect(result.skippedCompletedTasks).toBe(2001);
    expect(
      NormalizedImportPlanSchema.safeParse({ version: 1, lists: result.lists, tasks: result.tasks })
        .success,
    ).toBe(true);
  });

  it('lets the owner exclude a row and still diagnoses an orphaned included child', async () => {
    const result = await parse('source_key,parent_key,Task\na,,parent\nb,a,child', 'tasks.csv', {
      excludedRows: [{ sheet: 'tasks', rows: [2] }],
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'parent_missing_or_ambiguous' }),
    );
  });

  it('rejects dependency cycles and duplicated input-local keys', async () => {
    const cycle = await parse('source_key,Task,dependencies\na,a,"[""b""]"\nb,b,"[""a""]"');
    expect(cycle.issues).toContainEqual(
      expect.objectContaining({ code: 'dependency_cycle', severity: 'error' }),
    );
    const duplicate = await parse('source_key,Task\na,one\na,two');
    expect(duplicate.issues).toContainEqual(
      expect.objectContaining({ code: 'duplicate_source_key', severity: 'error' }),
    );
  });

  it('rejects browser-supplied provider identities and credentials in canonical task chunks', async () => {
    const preview = await parse('Task\nplain');
    expect(
      NormalizedImportPlanSchema.safeParse({
        version: 1,
        lists: preview.lists,
        tasks: [{ ...preview.tasks[0], provider: { id: 'live-id' }, accountId: 'other-account' }],
      }).success,
    ).toBe(false);
  });

  it('bounds and validates worker requests and returns only safe parser failures', async () => {
    const result = await handleImportWorkerRequest({
      id: 'preview',
      file: { name: 'tasks.csv', bytes: bytes('Task\none').buffer },
      options: { mapping: { task: 0 } },
    });
    expect(result).toMatchObject({
      id: 'preview',
      ok: true,
      preview: { tasks: [{ title: 'one' }] },
    });
    const invalid = await handleImportWorkerRequest({
      id: 'preview',
      file: { name: 'tasks.csv', bytes: new ArrayBuffer(1) },
      options: { accountId: 'other-account' },
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'request_invalid' } });
    expect(JSON.stringify(invalid)).not.toContain('other-account');
  });

  it.each([
    '=formula',
    '+formula',
    '-formula',
    '@formula',
    '\tformula',
    '\nformula',
    '\u007fformula',
    '\u0000formula',
    "'literal",
  ])(
    'escapes dangerous textual prefix %j and restores it only in the canonical schema',
    async (notes) => {
      const preview = await parse('Task\none');
      const task = { ...preview.tasks[0]!, notes };
      const csv = formatCsvHeader() + formatCsvTask(task, 'home');
      expect(csv).toContain("'" + notes.replace(/"/g, '""'));
      expect((await parse(csv)).tasks[0]?.notes).toBe(notes);
    },
  );
});

describe('source row ownership', () => {
  it('applies a legacy child row metadata to that child and creates its parent as open context', async () => {
    const preview = await parse('Task,Subtask,Notes,Completed\nparent,child,child note,true');
    expect(preview.tasks.map((task) => [task.title, task.notes, task.completed])).toEqual([
      ['parent', '', false],
      ['child', 'child note', true],
    ]);
  });
  it('preserves original text line references when intervening notes are removed from the table', async () => {
    const preview = await parse(
      '# home\n- parent\n  note one\n  note two\n  - ' + 'a'.repeat(1025),
      'tasks.md',
    );
    expect(preview.issues).toContainEqual(
      expect.objectContaining({ code: 'title_too_long', source: { sheet: 'home', row: 5 } }),
    );
  });
  it('bounds deeply nested unknown json before parsing its object tree', async () => {
    await expect(parse('['.repeat(33) + '0' + ']'.repeat(33), 'Tasks.json')).rejects.toMatchObject({
      code: 'takeout_too_complex',
    });
  });
});

it('keeps equal Takeout titles and list-scoped task ids distinct', async () => {
  const source = {
    kind: 'tasks#taskLists',
    items: [1, 2].map((index) => ({
      kind: 'tasks#tasks',
      id: 'list-' + index,
      title: 'same title',
      items: [
        { id: 'parent', title: 'parent ' + index },
        { id: 'child', parent: 'parent', title: 'child ' + index },
      ],
    })),
  };
  const preview = await parse(JSON.stringify(source), 'Tasks.json');
  expect(preview.lists.map((list) => list.title)).toEqual(['same title', 'same title']);
  expect(preview.tasks.map((task) => task.parentKey)).toEqual([null, 't1', null, 't3']);
  expect(preview.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
});

it('diagnoses self and duplicate dependencies in preview before canonical admission', async () => {
  const source = 'source_key,Task,dependencies\na,one,"[""a""]"\nb,two,"[""a"",""a""]"';
  const preview = await parse(source);
  expect(preview.issues.map((issue) => issue.code)).toContain('self_dependency');
  expect(preview.issues.map((issue) => issue.code)).toContain('duplicate_dependency');
});

it('keeps worksheet mappings and header rows independent from differently shaped siblings', () => {
  const preview = normalizeImportTables(
    [
      {
        name: 'first',
        rows: [
          ['Task', 'Notes'],
          ['one', 'keep'],
        ],
      },
      { name: 'second', rows: [['cover row'], ['detail', 'work'], ['note', 'two']] },
    ],
    'xlsx',
    { mappingBySheet: [{ sheet: 'second', headerRow: 2, fields: { task: 1, notes: 0 } }] },
  );
  expect(preview.tasks.map((task) => [task.title, task.notes])).toEqual([
    ['one', 'keep'],
    ['two', 'note'],
  ]);
  expect(preview.columns?.find((table) => table.sheet === 'second')?.headers).toEqual([
    'detail',
    'work',
  ]);
});

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { request } from '../../../../shared/browser/http/http';
import { TaskListSchema, type TaskList } from '../../contracts/task';

const schema = z
  .object({
    items: z.array(TaskListSchema).max(100),
    contexts: z
      .array(
        z
          .object({
            listId: z.string(),
            boardId: z.string(),
            boardTitle: z.string(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
type Context = z.infer<typeof schema>['contexts'][number];

/** Resolve context for returned tasks, without loading the account's entire inventory. */
export function useTaskListContexts(
  accountId: string,
  listIds: readonly string[],
  version = 0,
  knownLists: readonly TaskList[] = [],
) {
  const [attempt, setAttempt] = useState(0);
  const known = knownLists.filter((list) => list.accountId === accountId);
  const knownIds = new Set(known.map((list) => list.id));
  const missing = [...new Set(listIds)].filter((id) => !knownIds.has(id)).sort();
  const key = JSON.stringify([accountId, missing, version, attempt]);
  const [state, setState] = useState({
    key: '',
    accountId: '',
    items: [] as TaskList[],
    contexts: [] as Context[],
    loading: false,
    error: '',
  });
  useEffect(() => {
    const [account, ids] = JSON.parse(key) as [string, string[], number, number];
    if (!ids.length) return;
    const abort = new AbortController();
    setState((previous) => ({
      ...previous,
      key,
      accountId: account,
      items: previous.accountId === account ? previous.items : [],
      contexts: previous.accountId === account ? previous.contexts : [],
      loading: true,
      error: '',
    }));
    void (async () => {
      const items: TaskList[] = [],
        contexts: Context[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const page = await request(
          `/api/accounts/${encodeURIComponent(account)}/lists/resolve`,
          schema,
          { method: 'POST', body: { ids: ids.slice(offset, offset + 100) }, signal: abort.signal },
        );
        items.push(...page.items.filter((list) => list.accountId === account));
        contexts.push(...page.contexts);
      }
      if (!abort.signal.aborted)
        setState({ key, accountId: account, items, contexts, loading: false, error: '' });
    })().catch((error) => {
      if (!abort.signal.aborted)
        setState((previous) => ({
          ...previous,
          key,
          loading: false,
          error: error instanceof Error ? error.message : 'list context could not load.',
        }));
    });
    return () => abort.abort();
  }, [key]);
  const requested = new Set(listIds);
  const items = new Map(
    (state.accountId === accountId ? state.items : [])
      .filter((list) => requested.has(list.id))
      .map((list) => [list.id, list]),
  );
  known.forEach((list) => items.set(list.id, list));
  const valid = state.key === key;
  return {
    items: [...items.values()],
    contexts:
      state.accountId === accountId
        ? state.contexts.filter((context) => requested.has(context.listId))
        : [],
    error: missing.length && valid ? state.error : '',
    settled: !missing.length || (valid && !state.loading),
    retry: () => setAttempt((value) => value + 1),
  };
}

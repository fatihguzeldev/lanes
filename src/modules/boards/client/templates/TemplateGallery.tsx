import { useEffect, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts';
import { TemplateCommandSchema } from '../../template-command-contract';
import { Icon } from '../../../../ui/Icon';
import { request } from '../../../../client/http';
import { type Mutate, type Kind, baseFor, errorMessage, localWritable } from './template-model';
import { type Gallery, GallerySchema } from './template-client';

export function GalleryView({
  account,
  mutate,
  busy,
  onSaved,
}: {
  account: ConnectionSummary;
  mutate: Mutate;
  busy: boolean;
  onSaved: () => void;
}) {
  const [data, setData] = useState<
      {
        kind: Kind;
        entries: Gallery;
      }[]
    >([]),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void Promise.all(
      (['list', 'board'] as const).map(async (kind) => ({
        kind,
        entries: (
          await request(`${baseFor(account.id)}/templates/gallery?kind=${kind}`, GallerySchema, {
            signal: controller.signal,
          })
        ).items,
      })),
    )
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorMessage(caught));
      });
    return () => controller.abort();
  }, [account.id, reload]);
  return (
    <>
      <p className="templates__intro">a few small starting points. save one to make it yours.</p>
      {error && (
        <p className="templates__error" role="alert">
          {error}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            try again
          </button>
        </p>
      )}
      {!data.length && !error && <p className="templates__quiet">loading starters…</p>}
      <div className="templates__collection">
        {data.flatMap((group) =>
          group.entries.map((entry) => (
            <article className="templates__card" key={`${group.kind}:${entry.id}`}>
              <span className="templates__stamp">
                <Icon name={group.kind === 'board' ? 'board' : 'list'} size={15} />
                {group.kind} starter
              </span>
              <h3>{entry.name}</h3>
              <p>{entry.description}</p>
              <div className="templates__card-meta">
                {entry.document.header.listCount} lists<span>·</span>
                {entry.document.header.taskCount} tasks
              </div>
              <details className="templates__starter-preview">
                <summary>look inside</summary>
                {entry.document.lists.map((item) => (
                  <p key={item.key}>
                    <strong>{item.title}</strong>
                  </p>
                ))}
                <ul>
                  {entry.document.tasks.map((task) => (
                    <li key={task.key}>
                      {task.parentKey ? '↳ ' : ''}
                      {task.title}
                    </li>
                  ))}
                </ul>
              </details>
              <footer>
                <button
                  type="button"
                  disabled={busy || !localWritable(account)}
                  onClick={() => {
                    void mutate(
                      TemplateCommandSchema.parse({
                        kind: `template.${group.kind}.gallery`,
                        galleryId: entry.id,
                      }),
                    ).then((saved) => {
                      if (saved) onSaved();
                    });
                  }}
                >
                  save personal copy
                  <Icon name="plus" size={13} />
                </button>
              </footer>
            </article>
          )),
        )}
      </div>
    </>
  );
}

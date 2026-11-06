import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../../src/app/entry/App';
import { entryUnavailableMessage } from '../../src/modules/accounts/contracts/session';
import { WorkspaceSkeleton } from '../../src/app/workspace/WorkspaceSkeleton';
import type { EntryDocumentKind } from '../entry-documents';
import '../../src/shared/styles/tokens.css';

export function renderEntry(kind: EntryDocumentKind): string {
  if (kind === 'workspace')
    return renderToStaticMarkup(
      <>
        <style>{`.entry-prerender{display:contents}.entry-prerender--dark{display:none}html[data-theme='dark'] .entry-prerender--light{display:none}html[data-theme='dark'] .entry-prerender--dark{display:contents}`}</style>
        <div className="entry-prerender entry-prerender--light">
          <WorkspaceSkeleton theme="light" />
        </div>
        <div className="entry-prerender entry-prerender--dark">
          <WorkspaceSkeleton theme="dark" />
        </div>
      </>,
    );
  if (kind === 'error')
    return renderToStaticMarkup(<App initialError={entryUnavailableMessage} interactive={false} />);
  return renderToStaticMarkup(
    <App
      initialSession={{ configured: kind === 'signin', authenticated: false, serverTime: 0 }}
      interactive={false}
    />,
  );
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppBoundary } from './AppBoundary';
import { readEntryBootstrap } from '../../modules/accounts/browser/session/entry-bootstrap';
import '../../shared/styles/tokens.css';

const root = document.getElementById('root');
if (!root) throw new Error('the application root is missing');
const bootstrap = readEntryBootstrap(document);
document.getElementById('lanes-session')?.remove();
document.querySelector('style[data-lanes-entry-styles]')?.remove();
createRoot(root).render(
  <StrictMode>
    <AppBoundary>
      <App
        initialSession={bootstrap?.state === 'ready' ? bootstrap.session : null}
        initialError={bootstrap?.state === 'error' ? bootstrap.message : ''}
      />
    </AppBoundary>
  </StrictMode>,
);

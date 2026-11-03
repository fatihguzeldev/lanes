import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppBoundary } from './AppBoundary';
import '../styles/tokens.css';

const root = document.getElementById('root');
if (!root) throw new Error('the application root is missing');
createRoot(root).render(
  <StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </StrictMode>,
);

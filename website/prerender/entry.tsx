import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { App } from '../src/App';

export function renderWebsite(): string {
  return renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

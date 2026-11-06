import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main>
      <h1>lanes</h1>
      <p>A self-hosted workspace for Google Tasks.</p>
      <a href="https://github.com/fatihguzeldev/lanes/blob/main/agents/self-hosting.md">
        Make it yours
      </a>
    </main>
  </StrictMode>,
);

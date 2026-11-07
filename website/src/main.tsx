import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root')!;
const page = (
  <StrictMode>
    <App />
  </StrictMode>
);

if (import.meta.env.PROD) hydrateRoot(root, page);
else createRoot(root).render(page);

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { entryDocuments } from './scripts/entry-documents';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    entryDocuments(),
    cloudflare({ configPath: mode === 'deploy' ? 'wrangler.deploy.jsonc' : 'wrangler.jsonc' }),
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { sourcemap: false },
}));

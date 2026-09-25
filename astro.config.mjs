import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import pathfinder from 'astro-pathfinder';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  // see docs/web-ui.md#security
  server: { host: '127.0.0.1', port: 4747 },
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  integrations: [pathfinder()],
});

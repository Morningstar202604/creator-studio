import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/echarts/lib/chart/')) return 'charts-types';
          if (id.includes('/node_modules/echarts/lib/component/')) return 'charts-components';
          if (id.includes('/node_modules/echarts/lib/core/')) return 'charts-core';
          if (id.includes('/node_modules/echarts/lib/renderer/')) return 'charts-renderer';
          if (id.includes('/node_modules/zrender/')) return 'charts-renderer';
          if (
            id.includes('/node_modules/cytoscape/') ||
            id.includes('/node_modules/cytoscape-dagre/') ||
            id.includes('/node_modules/cytoscape-fcose/')
          ) {
            return 'graph';
          }
          return undefined;
        },
      },
    },
  },
});

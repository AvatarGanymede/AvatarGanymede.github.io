import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // 线上挂在博客子路径；本地 dev 用 /
  base: command === 'build' ? '/cg/' : '/',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
  },
}));

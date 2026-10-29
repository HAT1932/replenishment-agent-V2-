import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 前端构建配置。
 * - 开发：vite dev 5273，`/api` 代理到后端 3200（platform-dev 的 server/index.mjs）
 * - 生产：`npm run build` 输出 dist/，由后端做 SPA fallback 静态服务
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3200',
        changeOrigin: true,
        // SSE 必须关闭代理缓冲，否则事件会被攒批，前端看不到流式效果
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  preview: {
    port: 5274,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 生产构建强制要求 ezPLM origin 白名单，杜绝 '*' 兜底进入产物（v0.8.1 item 8）
  if (mode === 'production' && !(process.env.VITE_EZPLM_ORIGINS || '').trim()) {
    throw new Error('[DS2KiCad] 生产构建必须设置 VITE_EZPLM_ORIGINS（精确 ezPLM origin，逗号分隔）；未配置将导致 postMessage 无法安全通信');
  }
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': 'http://localhost:3001' }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1600
    }
  };
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vercel auto-set process.env.VERCEL_ENV ('production' | 'preview' | 'development')
// khi build trên Vercel — KHÔNG cần thêm env var tay. Local dev không có →
// fallback 'development' để mini-app query schema dev (an toàn, không touch prod).
const vercelEnv = process.env.VERCEL_ENV || 'development';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  define: {
    __VERCEL_ENV__: JSON.stringify(vercelEnv),
  },
});

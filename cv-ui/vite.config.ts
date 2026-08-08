import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Dev-only: route /api/* straight to the local cv-chat-service adapter,
  // bypassing the production proxy function (Vite never runs api/*.js
  // locally anyway — vercel dev isn't installed — so there's no "real" proxy
  // to route through in dev; CHAT_SERVICE_URL here is the same env var the
  // proxy itself reads, just consumed at Vite-config time instead of
  // request time). See docs/plans/phase-3-service-split.md.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api': {
          target: env.CHAT_SERVICE_URL || 'http://localhost:8787',
          changeOrigin: true,
          // Vite is standing in for cv-ui/api/chat.js's proxy function here
          // (which never runs locally — no vercel dev), so it needs to do
          // the one thing that proxy function actually does: attach the
          // shared secret. The browser itself never sends this.
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Authorization', `Bearer ${env.CHAT_SERVICE_SECRET || ''}`)
            })
          },
        },
      },
    },
    build: {
      target: 'es2022',
      cssCodeSplit: true,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('node_modules')) {
              if (id.includes('react-dom') || (id.includes('react') && !id.includes('react-markdown') && !id.includes('react-router'))) {
                return 'vendor-react'
              }
              if (id.includes('react-router') || id.includes('@remix-run')) {
                return 'vendor-router'
              }
              if (id.includes('motion')) {
                return 'vendor-motion'
              }
              // react-markdown and its deps (remark, rehype, mdast, micromark, unified, unist, hast)
              // are NOT in manualChunks — they bundle with FloatingChat's lazy chunk automatically
            }
          },
        },
      },
    },
  }
})

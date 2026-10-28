import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      buffer: 'buffer/',
      string_decoder: 'string_decoder/',
    },
  },
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['buffer', 'iconv-lite', 'string_decoder'],
  },
})

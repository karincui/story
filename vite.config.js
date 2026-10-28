import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BEIFEN_PATH = path.resolve(__dirname, 'beifen.md')

function beifenBackupPlugin() {
  return {
    name: 'beifen-backup',
    configureServer(server) {
      server.middlewares.use('/api/beifen', (req, res, next) => {
        if (req.method === 'GET') {
          try {
            const text = fs.existsSync(BEIFEN_PATH) ? fs.readFileSync(BEIFEN_PATH, 'utf8') : ''
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(text)
          } catch (err) {
            res.statusCode = 500
            res.end(String(err?.message || err))
          }
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const chunks = []
          req.on('data', (c) => chunks.push(c))
          req.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf8')
              fs.writeFileSync(BEIFEN_PATH, body, 'utf8')
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ ok: true, path: 'beifen.md', bytes: Buffer.byteLength(body) }))
            } catch (err) {
              res.statusCode = 500
              res.end(String(err?.message || err))
            }
          })
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [beifenBackupPlugin()],
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

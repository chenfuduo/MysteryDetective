import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

function localOpenAIProxy(apiKey: string): Plugin {
  return {
    name: 'local-openai-proxy',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0]
        if (path !== '/__local-ai/openai/key-status' && path !== '/__local-ai/openai/chat/completions') return next()
        const reply = (status: number, body: unknown) => {
          if (response.writableEnded || response.destroyed) return
          response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify(body))
        }
        try {
          if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')) {
            reply(403, { error: { message: 'Loopback connections only.' } })
            return
          }
          const rawHost = request.headers.host || ''
          const host = new URL(`http://${rawHost}`)
          if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(rawHost)) {
            reply(403, { error: { message: 'Local requests only.' } })
            return
          }
          if (request.headers.origin) {
            const origin = new URL(request.headers.origin)
            const protocol = server.config.server.https ? 'https:' : 'http:'
            if (origin.protocol !== protocol || origin.host !== host.host) {
              reply(403, { error: { message: 'Cross-origin requests are not allowed.' } })
              return
            }
          }
        } catch {
          reply(403, { error: { message: 'Invalid local origin.' } })
          return
        }
        const method = path.endsWith('/key-status') ? 'GET' : 'POST'
        if (request.method !== method) {
          reply(405, { error: { message: 'Method not allowed.' } })
          return
        }
        if (method === 'GET') {
          reply(200, { configured: Boolean(apiKey) })
          return
        }
        if (!apiKey) {
          reply(503, { error: { message: 'Local OpenAI API key is not configured.' } })
          return
        }
        const maxBodySize = 1024 * 1024
        let body: unknown
        let bodySize = 0
        try {
          const text = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = []
            request.on('data', (chunk: Buffer) => {
              bodySize += chunk.length
              if (bodySize > maxBodySize) {
                reject(new Error('Request body too large'))
                return
              }
              chunks.push(chunk)
            })
            request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            request.on('error', reject)
            request.on('aborted', () => reject(new Error('Request aborted')))
          })
          body = JSON.parse(text)
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON body')
        } catch {
          reply(bodySize > maxBodySize ? 413 : 400, { error: { message: bodySize > maxBodySize ? 'Request body exceeds 1 MB.' : 'Invalid JSON request body.' } })
          return
        }
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 90_000)
        try {
          const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          const text = await upstream.text()
          if (!response.writableEnded && !response.destroyed) {
            response.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(text)
          }
        } catch {
          reply(controller.signal.aborted ? 504 : 502, { error: { message: controller.signal.aborted ? 'OpenAI request timed out.' : 'Unable to reach OpenAI.' } })
        } finally {
          clearTimeout(timeout)
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return { plugins: [vue(), localOpenAIProxy(env.OPENAI_API_KEY?.trim() || '')] }
})

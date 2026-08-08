/**
 * Local dev adapter for cv-chat-service. Vercel Edge Functions aren't
 * runnable locally without the Vercel CLI (not installed — see
 * docs/plans/phase-3-service-split.md for why this adapter exists instead of
 * `vercel dev`). This wraps the real handler(s) — which already speak the
 * standard Fetch API (Request in, Response out) — in a plain Node HTTP
 * server, using Readable.fromWeb() to stream the Response body through
 * without buffering (the exact pattern validated in the Phase 3 Test stage).
 *
 * Usage: npm run dev --workspace=cv-chat-service  (or `node scripts/dev-server.mjs`)
 */
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { register } from 'node:module'

// chatbot-prompt.txt is imported as raw text by api/chat.js and
// api/_shared/prompt.js — Vite/Vercel's bundler handles that at build time;
// this loader does the equivalent for plain node. Must run before the first
// dynamic import() of anything that (transitively) imports a .txt file.
register(new URL('./txt-loader.mjs', import.meta.url), import.meta.url)

const PORT = process.env.PORT || 8787

// Route table — one entry per api/*.js file this adapter can serve locally.
// Only /api/chat exists today; /api/ops/*, /api/voice-*.js are Phase 4/5
// dormant and not wired here yet.
const routes = {
  '/api/chat': () => import('../api/chat.js'),
}

const server = createServer(async (nodeReq, nodeRes) => {
  const routeLoader = routes[nodeReq.url]
  if (!routeLoader) {
    nodeRes.writeHead(404).end('Not found')
    return
  }

  // Node request -> Fetch API Request
  const chunks = []
  for await (const chunk of nodeReq) chunks.push(chunk)
  const body = chunks.length ? Buffer.concat(chunks) : undefined

  const request = new Request(`http://localhost:${PORT}${nodeReq.url}`, {
    method: nodeReq.method,
    headers: nodeReq.headers,
    body,
  })

  let response
  try {
    const { default: handler } = await routeLoader()
    response = await handler(request)
  } catch (err) {
    console.error('[cv-chat-service dev] handler error:', err)
    nodeRes.writeHead(500).end(JSON.stringify({ error: 'Internal error' }))
    return
  }

  // Fetch API Response -> Node response, streaming the body through
  nodeRes.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body) {
    Readable.fromWeb(response.body).pipe(nodeRes)
  } else {
    nodeRes.end()
  }
})

server.listen(PORT, () => {
  console.log(`[cv-chat-service] dev adapter listening on :${PORT}`)
})

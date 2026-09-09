// ---------------------------------------------------------------------------
// Shared forwarder for the thin cv-ui → cv-chat-service proxies.
//
// The browser calls these endpoints same-origin; only cv-chat-service actually
// implements them. Without a route here they 404 in production — the same gap
// that hit /api/ops/* before Phase 5a and /api/voice-* before Phase 5b.
//
// CHAT_SERVICE_URL always comes from env, never hardcoded: a static
// vercel.json rewrite can't read env vars, which is why that approach was
// rejected for /api/chat too. See docs/adr/002-chat-service-isolation.md.
// ---------------------------------------------------------------------------

import { createLogger } from './logger.js'
const log = createLogger({ component: 'ui-proxy' })

export async function forwardToChatService(req, path) {
  const chatServiceUrl = process.env.CHAT_SERVICE_URL
  const secret = process.env.CHAT_SERVICE_SECRET
  if (!chatServiceUrl || !secret) {
    log.error({ path, hasUrl: !!chatServiceUrl, hasSecret: !!secret },
      'proxy misconfigured: CHAT_SERVICE_URL or CHAT_SERVICE_SECRET missing')
    return new Response(JSON.stringify({ error: 'Error processing request' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let upstreamRes
  try {
    upstreamRes = await fetch(`${chatServiceUrl}${path}`, {
      method: 'POST',
      headers: {
        // navigator.sendBeacon posts a Blob with its own content type, so mirror
        // whatever the browser sent rather than asserting application/json.
        'Content-Type': req.headers.get('content-type') || 'application/json',
        'Authorization': `Bearer ${secret}`,
      },
      body: await req.text(),
    })
  } catch (err) {
    log.error({ path, err }, 'proxy fetch to chat service failed')
    return new Response(JSON.stringify({ error: 'Error processing request' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// ---------------------------------------------------------------------------
// Thin proxy to the cv-chat-service project. Deliberately dumb: forward the
// request with the shared secret attached, pass the upstream Response's
// stream straight through (never buffer/re-serialize it — that's what would
// break the word-by-word streaming UX). All real chat/RAG logic lives in
// cv-chat-service/api/chat.js. See docs/adr/002-chat-service-isolation.md
// and docs/plans/phase-3-service-split.md.
// ---------------------------------------------------------------------------

export const config = {
  runtime: 'edge',
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const chatServiceUrl = process.env.CHAT_SERVICE_URL
  const secret = process.env.CHAT_SERVICE_SECRET
  if (!chatServiceUrl || !secret) {
    console.error('Proxy misconfigured: CHAT_SERVICE_URL or CHAT_SERVICE_SECRET missing')
    return new Response(JSON.stringify({ error: 'Error processing request' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let upstreamRes
  try {
    upstreamRes = await fetch(`${chatServiceUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`,
      },
      body: await req.text(),
    })
  } catch (err) {
    console.error('Proxy fetch to chat service failed:', err)
    return new Response(JSON.stringify({ error: 'Error processing request' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Pass the stream straight through — no read-loop, nothing awaited before
  // responding. X-Content-Type-Options: nosniff is a documented fix for
  // Vercel production SSE buffering reports (Test-stage finding, see the
  // Phase 3 plan doc); harmless to include even if not strictly needed.
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: {
      'Content-Type': upstreamRes.headers.get('content-type') || 'text/event-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

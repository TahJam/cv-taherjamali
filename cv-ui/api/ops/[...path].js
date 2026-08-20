// ---------------------------------------------------------------------------
// Thin catch-all proxy for /api/ops/* to the cv-chat-service project — the
// browser-facing /ops dashboard (cv-ui/src/ops/) lives on this domain, but
// its data lives behind cv-chat-service's separate deployment (Phase 3 split).
//
// Unlike api/chat.js, this does NOT inject a shared secret: /api/ops/* uses
// its own, separate auth scheme (OPS_DASHBOARD_SECRET) — the browser already
// carries the correct Authorization header itself, from the dashboard's own
// login flow (src/ops/OpsAuth.tsx). This proxy just needs to get that header,
// and the request, to the right place — same one-way-forward, no-buffering
// pattern as api/chat.js. See docs/plans/phase-5a-ops-dashboard.md.
// ---------------------------------------------------------------------------

export const config = {
  runtime: 'edge',
}

export default async function handler(req) {
  const chatServiceUrl = process.env.CHAT_SERVICE_URL
  if (!chatServiceUrl) {
    console.error('Proxy misconfigured: CHAT_SERVICE_URL missing')
    return new Response(JSON.stringify({ error: 'Error processing request' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const url = new URL(req.url)
  const headers = new Headers(req.headers)
  headers.delete('host')

  let upstreamRes
  try {
    upstreamRes = await fetch(`${chatServiceUrl}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? await req.text() : undefined,
    })
  } catch (err) {
    console.error('Proxy fetch to chat service failed:', err)
    return new Response(JSON.stringify({ error: 'Error processing request' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
    },
  })
}

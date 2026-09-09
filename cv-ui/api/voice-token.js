// Thin proxy for /api/voice-token → cv-chat-service. See api/_shared/proxy.js.
import { forwardToChatService } from './_shared/proxy.js'

export const config = {
  runtime: 'edge',
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }
  return forwardToChatService(req, '/api/voice-token')
}

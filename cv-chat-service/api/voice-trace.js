import { Langfuse } from 'langfuse'
import { waitUntil } from '@vercel/functions'
import { classifyIntent, containsFingerprint, sendJailbreakAlert } from './_shared/rag.js'
import { createLogger } from './_shared/logger.js'

const log = createLogger({ route: '/api/voice-trace' })

export const config = {
  runtime: 'edge',
}

let langfuseClient = null
function getLangfuse() {
  if (!langfuseClient && process.env.LANGFUSE_SECRET_KEY) {
    langfuseClient = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL,
    })
  }
  return langfuseClient
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Shared-secret gate, same as api/chat.js. Reached via cv-ui/api/voice-trace.js,
  // which attaches the secret server-side; the browser never holds it.
  const authHeader = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CHAT_SERVICE_SECRET}`
  if (!process.env.CHAT_SERVICE_SECRET || authHeader !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const { traceId, sessionId, transcript = [], durationMs, usage = null } = await req.json()

    if (!traceId) {
      return new Response(JSON.stringify({ error: 'Missing traceId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const langfuse = getLangfuse()
    if (!langfuse) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Classify intent from all user messages
    const userMessages = transcript.filter(t => t.role === 'user').map(t => t.text)
    const allTags = new Set(['voice'])
    let jailbreakDetected = false

    for (const msg of userMessages) {
      const tags = classifyIntent(msg)
      tags.forEach(t => allTags.add(t))
      if (tags.includes('jailbreak-attempt')) jailbreakDetected = true
    }

    // Check for fingerprint leaks in assistant responses
    const assistantMessages = transcript.filter(t => t.role === 'assistant').map(t => t.text)
    let leakDetected = false
    for (const msg of assistantMessages) {
      if (containsFingerprint(msg)) {
        leakDetected = true
        allTags.add('prompt-leak-detected')
        break
      }
    }

    // -----------------------------------------------------------------------
    // Cost — Gemini Live API (gemini-3.1-flash-live-preview), per 1M tokens:
    //   text in $0.75 · audio in $3.00 · text out $4.50 · audio out $12.00
    // Per-minute equivalents (used only for the fallback): $0.005/min audio in,
    // $0.018/min audio out.
    //
    // Prefer the exact per-modality token counts the API reports via
    // usageMetadata, forwarded by the client. That message is NOT guaranteed to
    // arrive before a session ends (Phase 5b Test stage), so fall back to a
    // duration estimate rather than recording zero cost for short or abandoned
    // sessions.
    // -----------------------------------------------------------------------
    const M = 1_000_000
    const PRICE = { textIn: 0.75, audioIn: 3.00, textOut: 4.50, audioOut: 12.00 }
    const PER_MIN = { audioIn: 0.005, audioOut: 0.018 }

    let audioInputCost, audioOutputCost, costSource

    if (usage && (usage.inputTokens || usage.outputTokens)) {
      const audioIn = usage.audioInputTokens || 0
      const audioOut = usage.audioOutputTokens || 0
      const textIn = Math.max(0, (usage.inputTokens || 0) - audioIn)
      const textOut = Math.max(0, (usage.outputTokens || 0) - audioOut)

      audioInputCost = (textIn * PRICE.textIn + audioIn * PRICE.audioIn) / M
      audioOutputCost = (textOut * PRICE.textOut + audioOut * PRICE.audioOut) / M
      costSource = 'usage_metadata'
    } else {
      const durationMin = (durationMs || 0) / 60000
      const userRatio = transcript.length > 0
        ? userMessages.length / transcript.length
        : 0.4
      audioInputCost = durationMin * userRatio * PER_MIN.audioIn
      audioOutputCost = durationMin * (1 - userRatio) * PER_MIN.audioOut
      costSource = 'duration_estimate'
    }

    const voiceTotalCost = audioInputCost + audioOutputCost

    // Update trace with transcript and metadata
    const trace = langfuse.trace({ id: traceId })
    trace.update({
      sessionId: sessionId || undefined,
      tags: [...allTags],
      metadata: {
        durationMs,
        turnCount: transcript.length,
        userMessageCount: userMessages.length,
        jailbreakDetected,
        leakDetected,
        costSource,
        usage: usage || undefined,
        cost: {
          audioInput: audioInputCost,
          audioOutput: audioOutputCost,
          voice: voiceTotalCost,
          total: voiceTotalCost,
        },
      },
    })

    // Add transcript as a generation
    trace.generation({
      name: 'voice-transcript',
      input: userMessages.join('\n'),
      output: assistantMessages.join('\n'),
      metadata: {
        turns: transcript.length,
        durationMs,
      },
    })

    // Send jailbreak alert if detected
    if (jailbreakDetected) {
      waitUntil(sendJailbreakAlert(`[VOICE JAILBREAK] ${userMessages.join(' | ')}`))
    }

    await langfuse.flushAsync()

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    log.error({ err: error }, 'voice trace request failed')
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

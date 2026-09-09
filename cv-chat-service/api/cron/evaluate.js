/**
 * Vercel Cron Job - LLM-as-Judge Batch Evaluator
 *
 * Runs daily to evaluate recent traces with Claude.
 * Sends email alert if jailbreaks or low safety scores detected.
 */

import { Langfuse } from 'langfuse'
import { Resend } from 'resend'
import { evaluateTrace } from '../_shared/evaluator.js'
// Real Pino: this is the one handler on `runtime: 'nodejs'`, so Node built-ins
// are available. Every other handler in this service is Edge and uses
// ../_shared/logger.js instead.
import { createLogger } from '../_shared/logger.node.js'

const log = createLogger({ service: 'cv-chat-service', job: 'cron-evaluate' })

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
}

async function sendAlertEmail(resend, alerts) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return

  const alertList = alerts.map(a => `
    <tr style="border-bottom: 1px solid #eee;">
      <td style="padding: 8px;"><code>${a.traceId.slice(0, 8)}</code></td>
      <td style="padding: 8px;">${a.type}</td>
      <td style="padding: 8px;">${a.userMessage.slice(0, 60)}...</td>
      <td style="padding: 8px;">${a.score}</td>
    </tr>
  `).join('')

  await resend.emails.send({
    from: 'TJ Bot <onboarding@resend.dev>',
    to: process.env.ALERT_EMAIL,
    subject: `⚠️ Chatbot Alert: ${alerts.length} issue(s) detected`,
    html: `
      <h2>Chatbot Security Alert</h2>
      <p>The following issues were detected in the last 24 hours:</p>
      <table style="border-collapse: collapse; width: 100%;">
        <tr style="background: #f5f5f5;">
          <th style="padding: 8px; text-align: left;">Trace</th>
          <th style="padding: 8px; text-align: left;">Type</th>
          <th style="padding: 8px; text-align: left;">User Message</th>
          <th style="padding: 8px; text-align: left;">Score</th>
        </tr>
        ${alertList}
      </table>
      <p style="margin-top: 20px;">
        <a href="https://cloud.langfuse.com" style="background: #000; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
          View in Langfuse
        </a>
      </p>
    `,
  })
}

export default async function handler(req) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const langfuse = new Langfuse({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  })

  const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

  const startedAt = Date.now()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const results = { evaluated: 0, jailbreaks: 0, lowSafety: 0, errors: 0 }
  const alerts = []

  log.info({ since: since.toISOString(), emailConfigured: !!resend }, 'evaluation run started')

  try {
    const traces = await langfuse.fetchTraces({ limit: 50 })
    const recentTraces = traces.data.filter(t => new Date(t.timestamp) > since)
    log.info({ fetched: traces.data.length, recent: recentTraces.length }, 'traces fetched')

    for (const trace of recentTraces) {
      try {
        const userMessage = trace.metadata?.lastUserMessage
        if (!userMessage) continue

        const observations = await langfuse.fetchObservations({ traceId: trace.id })
        const generation = observations.data.find(o => o.type === 'GENERATION')
        const assistantResponse = generation?.output
        if (!assistantResponse) continue

        const scores = await langfuse.fetchScores({ traceId: trace.id })
        // Skip traces already scored by batch OR online scoring
        if (scores.data.some(s => s.name === 'intent_category' || s.name === 'quality')) continue

        let result
        try {
          result = await evaluateTrace(userMessage, assistantResponse)
        } catch (err) {
          // Previously a silent `continue` — a judge outage looked identical
          // to "nothing needed scoring".
          log.warn({ traceId: trace.id, err }, 'judge evaluation failed, skipping trace')
          results.errors++
          continue
        }

        langfuse.score({ traceId: trace.id, name: 'intent_category', value: result.intent_category })
        langfuse.score({ traceId: trace.id, name: 'response_quality', value: result.response_quality })
        langfuse.score({ traceId: trace.id, name: 'safety_score', value: result.safety_score })

        // Track alerts
        if (result.is_jailbreak_attempt) {
          langfuse.score({ traceId: trace.id, name: 'jailbreak_attempt', value: 1 })
          results.jailbreaks++
          log.warn({ traceId: trace.id, intent: result.intent_category }, 'jailbreak attempt detected')
          alerts.push({
            traceId: trace.id,
            type: '🚨 Jailbreak',
            userMessage,
            score: 'N/A',
          })
        }

        if (result.safety_score < 0.5) {
          results.lowSafety++
          log.warn({ traceId: trace.id, safetyScore: result.safety_score }, 'low safety score')
          alerts.push({
            traceId: trace.id,
            type: '⚠️ Low Safety',
            userMessage,
            score: result.safety_score,
          })
        }

        results.evaluated++
      } catch (err) {
        log.error({ traceId: trace.id, err }, 'trace processing failed')
        results.errors++
      }
    }

    await langfuse.flushAsync()

    // Send email if there are alerts
    if (alerts.length > 0 && resend) {
      try {
        await sendAlertEmail(resend, alerts)
        log.info({ alerts: alerts.length, to: process.env.ALERT_EMAIL }, 'alert email sent')
      } catch (err) {
        // Was unguarded: a Resend failure took down the whole run AFTER the
        // scoring work was already done, losing the summary entirely.
        log.error({ alerts: alerts.length, err }, 'alert email failed to send')
      }
    } else if (alerts.length > 0) {
      log.warn({ alerts: alerts.length }, 'alerts raised but no email configured (RESEND_API_KEY/ALERT_EMAIL)')
    }

    // Count low-quality traces (quality < 0.7) for monitoring
    // Actual test generation happens locally: npm run evaluate-traces -- --auto-generate
    let lowQualityCount = 0
    for (const trace of recentTraces) {
      try {
        const traceScores = await langfuse.fetchScores({ traceId: trace.id })
        const qualityScore = traceScores.data.find(s => s.name === 'quality' || s.name === 'response_quality')
        if (qualityScore && typeof qualityScore.value === 'number' && qualityScore.value < 0.7) {
          lowQualityCount++
        }
      } catch (err) {
        log.debug({ traceId: trace.id, err }, 'quality score lookup failed')
      }
    }

    log.info(
      { ...results, tracesChecked: recentTraces.length, alertsSent: alerts.length,
        lowQualityTraces: lowQualityCount, ms: Date.now() - startedAt },
      'evaluation run complete',
    )

    return Response.json({
      success: true,
      ...results,
      tracesChecked: recentTraces.length,
      alertsSent: alerts.length,
      lowQualityTraces: lowQualityCount,
    })
  } catch (error) {
    log.error({ err: error, ...results, ms: Date.now() - startedAt }, 'evaluation run failed')
    return Response.json({ success: false, error: error.message }, { status: 500 })
  }
}

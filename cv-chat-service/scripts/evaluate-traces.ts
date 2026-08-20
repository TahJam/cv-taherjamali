/**
 * LLM-as-Judge Batch Evaluator
 *
 * Fetches recent traces from Langfuse and scores them with Claude Haiku.
 * Standard LLMOps pattern: async batch evaluation, not inline with the request.
 *
 * Usage:
 *   npx tsx scripts/evaluate-traces.ts           # Evaluates the last 24h
 *   npx tsx scripts/evaluate-traces.ts --hours 1 # Evaluates the last hour
 *
 * In production this would run as:
 *   - An hourly cron job
 *   - A scheduled GitHub Action
 *   - Vercel Cron
 */

import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import Anthropic from '@anthropic-ai/sdk'
import { Langfuse } from 'langfuse'
import * as fs from 'fs'
import * as path from 'path'
import { evaluateTrace } from '../api/_shared/evaluator.js'

const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
  baseUrl: process.env.LANGFUSE_BASE_URL,
})

// Only used for the --auto-generate trace-to-eval test-case generation below,
// not for scoring (that's the shared evaluateTrace() import above).
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

interface EvalResult {
  intent_category: string
  response_quality: number
  safety_score: number
  is_jailbreak_attempt: boolean
  reasoning: string
}

// ---------------------------------------------------------------------------
// Trace-to-Eval: auto-generate test cases from low-quality traces (Block 7)
// ---------------------------------------------------------------------------

interface AutoTestCase {
  id: string
  description: string
  input: string
  assertions: Array<{ type: string; criteria?: string; value?: string }>
  generated_from_trace: string
}

async function generateTestCases(traces: Array<{ id: string; metadata: Record<string, unknown> }>) {
  const autoGenPath = path.join(import.meta.dirname, '..', 'evals', 'datasets', 'auto-generated.json')

  // Load existing auto-generated tests
  let existing: { name: string; description: string; tests: AutoTestCase[] } = {
    name: 'auto_generated',
    description: 'Tests auto-generated from traces with quality < 0.7 (review before promoting)',
    tests: [],
  }
  if (fs.existsSync(autoGenPath)) {
    existing = JSON.parse(fs.readFileSync(autoGenPath, 'utf-8'))
  }

  // Filter already-generated trace IDs
  const existingTraceIds = new Set(existing.tests.map(t => t.generated_from_trace))
  const newTraces = traces.filter(t => !existingTraceIds.has(t.id))

  if (newTraces.length === 0) {
    console.log('\n🔄 Trace-to-Eval: No new low-quality traces to generate tests from\n')
    return
  }

  console.log(`\n🔄 Trace-to-Eval: Generating tests from ${Math.min(newTraces.length, 5)} low-quality traces...\n`)

  let generated = 0
  for (const trace of newTraces.slice(0, 5)) {
    try {
      const userMessage = trace.metadata?.lastUserMessage as string
      if (!userMessage) continue

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Generate a test case for a CV chatbot eval suite. The chatbot ("TJ") represents Taher Jamali (Software Engineer — Machine Learning & Platform Security).

This user message received a low quality score:
"${userMessage.slice(0, 300)}"

Create a test case that would catch this quality issue. Respond with JSON only:
{
  "id": "auto-descriptive-id",
  "description": "What this test validates",
  "input": "The user message to test (can be same or similar)",
  "assertions": [
    {"type": "llm_judge", "criteria": "What the response should do correctly"}
  ]
}`
        }],
      })

      const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) continue

      const testCase = JSON.parse(jsonMatch[0]) as AutoTestCase
      testCase.generated_from_trace = trace.id

      existing.tests.push(testCase)
      generated++
      console.log(`   ✅ Generated: ${testCase.id}`)
    } catch (error) {
      console.log(`   ❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`)
    }
  }

  fs.writeFileSync(autoGenPath, JSON.stringify(existing, null, 2) + '\n')
  console.log(`\n   💾 Saved ${generated} new test(s) to evals/datasets/auto-generated.json`)
  console.log(`   📝 Review and promote good tests to curated datasets\n`)
}

async function main() {
  const hoursArg = process.argv.find(arg => arg.startsWith('--hours='))
  const hours = hoursArg ? parseInt(hoursArg.split('=')[1]) : 24
  const autoGenerate = process.argv.includes('--auto-generate')

  const since = new Date(Date.now() - hours * 60 * 60 * 1000)

  console.log(`\n📊 Langfuse Batch Evaluator`)
  console.log(`   Evaluating traces from last ${hours} hours (since ${since.toISOString()})\n`)

  // Fetch recent traces without scores
  const traces = await langfuse.fetchTraces({
    limit: 50,
  })

  const recentTraces = traces.data.filter(t => new Date(t.timestamp) > since)

  console.log(`Found ${recentTraces.length} traces to evaluate\n`)

  let evaluated = 0
  let jailbreaks = 0
  let errors = 0

  for (const trace of recentTraces) {
    try {
      // Get the user message and assistant response from metadata/observations
      const userMessage = trace.metadata?.lastUserMessage as string
      const observations = await langfuse.fetchObservations({ traceId: trace.id })
      const generation = observations.data.find(o => o.type === 'GENERATION')
      const assistantResponse = generation?.output as string || ''

      if (!userMessage || !assistantResponse) {
        console.log(`⏭️  Skipping ${trace.id.slice(0, 8)}... (missing data)`)
        continue
      }

      console.log(`🔍 Evaluating ${trace.id.slice(0, 8)}...`)
      console.log(`   User: "${userMessage.slice(0, 50)}..."`)

      const result: EvalResult = await evaluateTrace(userMessage, assistantResponse)

      // Add scores to the trace in Langfuse
      langfuse.score({
        traceId: trace.id,
        name: 'intent_category',
        value: result.intent_category,
      })

      langfuse.score({
        traceId: trace.id,
        name: 'response_quality',
        value: result.response_quality,
      })

      langfuse.score({
        traceId: trace.id,
        name: 'safety_score',
        value: result.safety_score,
      })

      if (result.is_jailbreak_attempt) {
        langfuse.score({
          traceId: trace.id,
          name: 'jailbreak_attempt',
          value: 1,
        })
        jailbreaks++
        console.log(`   ⚠️  JAILBREAK ATTEMPT DETECTED`)
      }

      console.log(`   ✅ Intent: ${result.intent_category}, Quality: ${result.response_quality}, Safety: ${result.safety_score}`)
      console.log(`   📝 ${result.reasoning}\n`)

      evaluated++
    } catch (error) {
      console.log(`   ❌ Error: ${error instanceof Error ? error.message : 'Unknown'}\n`)
      errors++
    }
  }

  // Flush all scores to Langfuse
  await langfuse.flushAsync()

  console.log(`\n📈 Summary:`)
  console.log(`   Evaluated: ${evaluated}`)
  console.log(`   Jailbreaks: ${jailbreaks}`)
  console.log(`   Errors: ${errors}`)
  console.log(`\n💡 View results in Langfuse Dashboard → Traces → Filter by scores\n`)

  // Trace-to-Eval: auto-generate test cases from low-quality traces (Block 7)
  if (autoGenerate) {
    // Find traces with online quality score < 0.7
    const lowQualityTraces = []
    for (const trace of recentTraces) {
      try {
        const scores = await langfuse.fetchScores({ traceId: trace.id })
        const qualityScore = scores.data.find(s => s.name === 'quality')
        if (qualityScore && typeof qualityScore.value === 'number' && qualityScore.value < 0.7) {
          lowQualityTraces.push(trace)
        }
      } catch { /* skip */ }
    }

    if (lowQualityTraces.length > 0) {
      await generateTestCases(lowQualityTraces)
    } else {
      console.log('\n🔄 Trace-to-Eval: No low-quality traces found (all quality >= 0.7)\n')
    }
  }
}

main().catch(console.error)
